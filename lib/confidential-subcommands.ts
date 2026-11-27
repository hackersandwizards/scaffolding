import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  directoryHoldsFile,
  findPurgedCommitFindings,
  hasLfsOrLockableAttr,
  parsePrepushRefs,
  type PurgedHashList,
} from "./confidential-git.ts";
import { parsePurgedList, PurgedListFormatError } from "./confidential-input.ts";
import {
  collectPublishedGrams,
  createTermHasher,
  findShortNeverNames,
  parseTermLines,
  splitPipedTermLists,
  TermVariantHasher,
} from "./confidential-terms.ts";
import { fetchWaitS, git, reader, type Finding } from "./repo.ts";

export type CommandResult = { stdout?: string; stderr?: string; exitCode: number };

export function cliFlagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

export function validateNeverBuildNames(names: readonly string[]): string | undefined {
  const short = findShortNeverNames(names);
  if (short.length) {
    return `[check-confidential] --never: under three letters: ${short.join(", ")}; not building. Remove or lengthen the sub-3-letter entries in the --never input (after legal-suffix stripping) and re-run \`check-confidential build\``;
  }
  if (!names.length) {
    return "[check-confidential] --never: no name; not building. Pass at least one name via --never <file> (or after a NUL byte on stdin) and re-run `check-confidential build`";
  }
  return undefined;
}

export function readExistingPurgedList(root: string): {
  list?: ReturnType<typeof parsePurgedList>;
  malformed: boolean;
} {
  let malformed = false;
  for (const read of [reader(root, false), reader(root, true)]) {
    let text: string;
    try {
      text = read(".confidential-purged.json").toString();
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    try {
      return { list: parsePurgedList(text), malformed: false };
    } catch {
      malformed = true;
    }
  }
  return { malformed };
}

/** The folders of the local Git LFS store's objects: the common Git folder's, and lfs.storage's. */
export function lfsObjectDirs(root: string): string[] {
  const common = resolve(root, git(["rev-parse", "--git-common-dir"], root).toString().trim());
  const storage = spawnSync("git", ["config", "--type=path", "lfs.storage"], { cwd: root })
    .stdout.toString()
    .trim();
  return [join(common, "lfs/objects"), ...(storage ? [resolve(common, storage, "objects")] : [])];
}

export function parsePurgedHashEntry(
  raw: string,
  where: string,
): { entry?: PurgedHashList; finding?: Finding } {
  // `purged <sha> > .confidential-purged.json` leaves the file empty where it fails.
  if (!raw.trim()) return {};
  let list: ReturnType<typeof parsePurgedList>;
  try {
    list = parsePurgedList(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof PurgedListFormatError)) throw error;
    return {
      finding: {
        check: "confidential",
        path: "push",
        text: ".confidential-purged.json",
        message: `${where} is malformed, so the push cannot be checked for purged commits. Restore .confidential-purged.json there with its original salt string and hashes array, then retry the push.`,
      },
    };
  }
  return { entry: { bad: new Set(list.hashes), hash: createTermHasher(list.salt) } };
}

export function hasLfsTrackedChanges(
  root: string,
  local: string,
  notOnRemote: readonly string[],
): boolean {
  // latin1 keeps a path's bytes as they are, whatever its encoding. -c lists the paths a merge's
  // resolution changes; what it takes from a side counts through that side's own commits.
  const changed = git(
    ["log", "-c", "--format=", "--name-only", "--no-renames", "-z", local, ...notOnRemote],
    root,
  )
    .toString("latin1")
    .split("\0")
    .filter(Boolean);
  if (!changed.length) return false;
  const paths = Buffer.from(`${[...new Set(changed)].join("\0")}\0`, "latin1");
  const checkAttr = (source: string[]) =>
    spawnSync("git", ["check-attr", ...source, "-z", "--stdin", "filter", "lockable"], {
      cwd: root,
      input: paths,
    });
  // --source needs Git 2.40; an older git reads the checked-out attributes.
  let result = checkAttr([`--source=${local}`]);
  if (result.status !== 0) result = checkAttr([]);
  if (result.status !== 0) throw new Error(`git check-attr: ${result.stderr}`);
  return hasLfsOrLockableAttr(result.stdout.toString("latin1"));
}

function fetchRemotePurgedList(
  root: string,
  remoteName: string,
  remoteTarget: string,
): { entry?: PurgedHashList; findings: Finding[] } {
  const findings: Finding[] = [];
  const ref = `refs/scaffolding/remote-purged-${process.pid}`;
  const wait = fetchWaitS();
  const fetched = spawnSync(
    "git",
    ["fetch", "-q", "--no-tags", "--no-write-fetch-head", remoteTarget, `+HEAD:${ref}`],
    {
      cwd: root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: "ignore",
      timeout: wait * 1000,
    },
  );
  if ((fetched.error as { code?: string } | undefined)?.code === "ETIMEDOUT") {
    findings.push({
      check: "confidential",
      path: "push",
      text: ".confidential-purged.json",
      message: `the list on the remote's default branch did not arrive within ${wait} s: run \`git fetch ${remoteName}\`, then push again`,
    });
  }
  const list = spawnSync("git", ["show", `${ref}:.confidential-purged.json`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: Infinity,
  });
  spawnSync("git", ["update-ref", "-d", ref], { cwd: root });
  if (fetched.status !== 0 || list.status !== 0) return { findings };
  const parsed = parsePurgedHashEntry(list.stdout, "the list on the remote's default branch");
  if (parsed.finding) findings.push(parsed.finding);
  return { entry: parsed.entry, findings };
}

export function buildTermListJson(
  argv: readonly string[],
  stdin: string,
  dictFile = "/usr/share/dict/words",
): CommandResult {
  const neverFlag = argv.includes("--never");
  const neverFile = neverFlag ? (cliFlagValue(argv, "--never") ?? "") : undefined;
  const piped = splitPipedTermLists(stdin);
  const readLines = (file: string, part: number) =>
    parseTermLines(file === "-" ? piped[part] : readFileSync(file, "utf8"));
  const terms = readLines(argv[1], 0);
  const names = neverFile ? readLines(neverFile, 1) : [];
  const neverError = neverFile !== undefined ? validateNeverBuildNames(names) : undefined;
  if (neverError) return { stderr: neverError, exitCode: 1 };
  // Without the dictionary every common word on the list would refuse ordinary text everywhere.
  if (!existsSync(dictFile)) {
    return {
      stderr: `[check-confidential] no ${dictFile} on this machine: not building. Run \`check-confidential build\` on macOS or install a wordlist package (such as wamerican/words) providing ${dictFile}`,
      exitCode: 1,
    };
  }
  const dictionary = new Set(readFileSync(dictFile, "utf8").toLowerCase().split("\n"));
  const publicFile = cliFlagValue(argv, "--public");
  const published = publicFile
    ? collectPublishedGrams(readFileSync(publicFile, "utf8"))
    : new Set<string>();
  const salt = randomBytes(16).toString("hex");
  const variantHasher = new TermVariantHasher(salt, dictionary);
  const publicTerms = variantHasher.hashPublicTerms(terms, published);
  const neverTerms = variantHasher.hashNeverNames(names);
  return {
    stdout: JSON.stringify({
      built: new Date().toISOString(),
      salt,
      maxTokens: Math.max(publicTerms.maxTokens, neverTerms.maxTokens),
      hashes: publicTerms.hashes,
      never: neverFile ? neverTerms.hashes : undefined,
    }),
    exitCode: 0,
  };
}

export function buildPurgedListJson(root: string, shas: readonly string[]): CommandResult {
  // Adds to the repository's list under its own salt. `> .confidential-purged.json` empties the
  // file before this runs, so then the index's copy counts.
  const { list: old, malformed } = readExistingPurgedList(root);
  if (!old && malformed) {
    return {
      stderr:
        "[check-confidential] .confidential-purged.json is malformed, so the purged list cannot be extended safely. Restore the file with its original salt string and hashes array, then rerun the purged command.",
      exitCode: 1,
    };
  }
  const salt = old?.salt ?? randomBytes(16).toString("hex");
  const hashes = new Set([...(old?.hashes ?? []), ...shas.map(createTermHasher(salt))]);
  return { stdout: JSON.stringify({ salt, hashes: [...hashes].sort() }), exitCode: 0 };
}

function collectPrepushPurgedFindings(
  root: string,
  argv: readonly string[],
  commits: readonly string[],
): Finding[] {
  const findings: Finding[] = [];
  const purged: PurgedHashList[] = [];
  const file = join(root, ".confidential-purged.json");
  if (existsSync(file)) {
    const local = parsePurgedHashEntry(readFileSync(file, "utf8"), "the list in this checkout");
    if (local.entry) purged.push(local.entry);
    if (local.finding) findings.push(local.finding);
  }
  // A clone older than the list carries the purged commits without it, so the list on the remote's
  // default branch counts too: fetched into a ref of this run's own within fetchWaitS(). A remote
  // without a list, or out of reach, adds nothing. A fetch past the bound refuses: the old clone
  // shares no commit with the rewritten history and fetches all of it, which a slow line takes
  // longer than 20 s for; a fetch of the remote first leaves this one little to fetch.
  if (commits.length) {
    const remote = fetchRemotePurgedList(root, argv[1], argv[2] ?? argv[1]);
    if (remote.entry) purged.push(remote.entry);
    findings.push(...remote.findings);
  }
  findings.push(...findPurgedCommitFindings(commits, purged));
  return findings;
}

export function evaluatePrepush(
  argv: readonly string[],
  root: string,
  input: string,
): { findings: Finding[]; invokeLfs: boolean } {
  const { locals, remoteTips } = parsePrepushRefs(input);
  // New to the remote pushed to: a commit another remote already holds may still be missing there.
  // Its tips from the input cover a push to a URL, which has no tracking refs.
  const notOnRemote = ["--ignore-missing", "--not", `--remotes=${argv[1]}`, ...remoteTips];
  // Only the tips the remote reports count as held there: a stale tracking ref or a fetched pull
  // request may still point into the purged history.
  const commits = locals.flatMap((local) =>
    git(["rev-list", local, "--ignore-missing", "--not", ...remoteTips], root)
      .toString()
      .split("\n")
      .filter(Boolean),
  );
  const findings = collectPrepushPurgedFindings(root, argv, commits);
  if (findings.length) return { findings, invokeLfs: false };
  // git-lfs stays off unless the push may carry LFS objects or touch a lockable file: it would
  // verify locks against the remote on every push.
  const needsLfs =
    lfsObjectDirs(root).some(directoryHoldsFile) ||
    locals.some((local) => hasLfsTrackedChanges(root, local, notOnRemote));
  if (!needsLfs) return { findings, invokeLfs: false };
  if (spawnSync("git", ["lfs", "version"], { cwd: root }).status !== 0) {
    findings.push({
      check: "confidential",
      path: "push",
      text: "",
      message:
        "this push may carry Git LFS content or touch a lockable file, and git-lfs is not on PATH: install git-lfs (brew install git-lfs && git lfs install) and push again",
    });
    return { findings, invokeLfs: false };
  }
  return { findings, invokeLfs: true };
}
