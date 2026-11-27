#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
//   check-confidential --staged               pre-commit: added lines and binary files in the index
//   --list-optional                           with --staged or --message-file: no list reachable
//                                             passes with a warning, for outside contributors, as
//                                             does a file this machine cannot read (no OCR)
//   check-confidential --message-file <file>  commit-msg: the commit message
//   check-confidential --commit <rev>         one commit: its added lines, images, PDFs and message
//   check-confidential --index                every file of the index, the gate's audit
//   check-confidential --tree <rev>           every file of a tree, for an audit
//   check-confidential prepush                pre-push: refuses commits listed in
//                                             .confidential-purged.json, then hands the refs to
//                                             `git lfs pre-push` where the push may carry LFS content
//                                             or touch a lockable file
//   check-confidential never                  reads {"<where>": <text or JSON>} on stdin, refuses every
//                                             name of the list's never section in any case, in
//                                             private repositories too: a deck test's strings
//   check-confidential fetch                  fetches the list now, for a cloud setup script
//   check-confidential build <terms|-> [--public <file>] [--never <file>]
//                                             prints a hashed list from one term per line (- reads
//                                             stdin), stamped with its build time, leaving out every
//                                             term the public text in <file> already carries;
//                                             --never adds the never section, every name kept;
//                                             --never - reads it from stdin after a NUL byte
//   check-confidential purged <sha>...        prints .confidential-purged.json for purged commits
import { applyAllow, auditAllow } from "../lib/allow-entries.ts";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectCompanyOsNav,
  isBinaryExtension,
  isLfsPointer,
  LFS_OID_PATTERN,
  parseLfsPointer,
  readLfsContent,
} from "../lib/confidential-archive.ts";
import {
  agentWorkCiFindings,
  BinaryContentScanner,
  type BinaryFile,
} from "../lib/confidential-binaries.ts";
import {
  ConfidentialListCache,
  neverListProblemFindings,
  publicListProblemFindings,
} from "../lib/confidential-cache.ts";
import {
  parseCatFileBatch,
  parseIndexEntries,
  parseNumstatEntries,
  parseTreeEntries,
} from "../lib/confidential-git.ts";
import { addedLines, type TermList } from "../lib/confidential-input.ts";
import {
  buildPurgedListJson,
  buildTermListJson,
  cliFlagValue,
  evaluatePrepush,
  lfsObjectDirs,
} from "../lib/confidential-subcommands.ts";
import {
  ConfidentialTermMatcher,
  neverBadTermSet,
  neverPathFinding,
  neverTermFinding,
  parseNeverInput,
  publicBadTermSet,
  publicPathFinding,
  publicTermFinding,
  stripPackageAllowTargets,
} from "../lib/confidential-terms.ts";
import { help } from "../lib/help.ts";
import { finish, git, readPackage, repoRoot, type Finding } from "../lib/repo.ts";

const USAGE =
  "usage: check-confidential --staged | --message-file <file> [--list-optional] | --commit <rev> | --index | --tree <rev> | never | prepush | fetch | build <terms|-> [--public <file>] [--never <file>] | purged <sha>...";
help("check-confidential", USAGE);

const started = performance.now();
const argv = process.argv.slice(2);
const arg = (flag: string) => cliFlagValue(argv, flag);

function exitWithResult(result: { stdout?: string; stderr?: string; exitCode: number }): never {
  if (result.stdout !== undefined) console.log(result.stdout);
  if (result.stderr !== undefined) console.error(result.stderr);
  process.exit(result.exitCode);
}

if (argv[0] === "build") {
  const stdin = [argv[1], arg("--never")].includes("-") ? readFileSync(0, "utf8") : "";
  exitWithResult(buildTermListJson(argv, stdin));
}
if (argv[0] === "purged") exitWithResult(buildPurgedListJson(repoRoot(), argv.slice(1)));

const neverMode = argv[0] === "never";
if (neverMode && process.env.CI === "true") {
  console.error("[check-confidential] CI: never scan skipped");
  process.exit(0);
}
const root = repoRoot();
if (argv[0] === "prepush") {
  const input = readFileSync(0);
  const { findings: prepushFindings, invokeLfs } = evaluatePrepush(argv, root, input.toString());
  if (invokeLfs) {
    const lfs = spawnSync("git", ["lfs", "pre-push", ...argv.slice(1)], {
      cwd: root,
      input,
      stdio: ["pipe", "inherit", "inherit"],
    });
    process.exit(lfs.status ?? 1);
  }
  finish("check-confidential", prepushFindings, started);
}

const CACHE_DIR = join(root, "node_modules/.cache/scaffolding");
const OCR_SOURCE = join(import.meta.dir, "../lib/ocr.swift");
const READER_SOURCES = [
  import.meta.path,
  fileURLToPath(new URL("../lib/confidential-input.ts", import.meta.url)),
  fileURLToPath(new URL("../lib/confidential-archive.ts", import.meta.url)),
  fileURLToPath(new URL("../lib/confidential-binaries.ts", import.meta.url)),
  OCR_SOURCE,
];
const warn = (message: string) => console.error(`[check-confidential] ${message}`);
const listCache = new ConfidentialListCache(CACHE_DIR, warn);
const explicitList = arg("--list") || process.env.SCAFFOLDING_CONFIDENTIAL_TERMS || undefined;

if (argv[0] === "fetch") {
  const problem = listCache.fetchList();
  const loaded = problem ? { problem } : listCache.loadPublicRequired(explicitList);
  if (loaded.problem) warn(loaded.problem);
  process.exit(loaded.problem ? 1 : 0);
}

const CHECK = neverMode ? "never-shown" : "confidential";
const message = arg("--message-file");
const commit = arg("--commit");
const optional =
  argv.includes("--list-optional") && (argv.includes("--staged") || Boolean(message));
const tree = arg("--tree");
const index = argv.includes("--index");
const skipped = process.env.CI === "true" && Boolean(tree || index);
// `private` and the allow list come from the snapshot scanned, so a commit adding a case and its
// allow entry together is judged as one and an unstaged edit switches no scan off. A message
// belongs to the commit the index makes. The never scan reads what the working tree renders, and
// runs in a private repository too: no surface shows those names.
const pkg = readPackage(root, neverMode ? undefined : (tree ?? commit ?? ":"));
if (pkg.scaffolding?.private === true && !neverMode) process.exit(0);
const ownPackage = stripPackageAllowTargets(pkg);
const ownText = (path: string, text: string) => (path === "package.json" ? ownPackage : text);

const findings: Finding[] = [];
const report = (path: string, text: string, details: string) => {
  findings.push({ check: "confidential", path, text, message: details });
};

let list: TermList | undefined;
let unscanned = false;
// Kept out of the allow check: no allow entry may switch the list requirement off.
const listProblem: Finding[] = [];
if (skipped) warn("CI: term step skipped; the commit hook is the gate");
else {
  const loaded = neverMode
    ? optional
      ? listCache.loadNeverOptional(explicitList)
      : listCache.loadNeverRequired(explicitList)
    : optional
      ? listCache.loadPublicOptional(explicitList)
      : listCache.loadPublicRequired(explicitList);
  list = loaded.list;
  unscanned = Boolean(loaded.absent && optional);
  if (unscanned) warn(`${loaded.problem}; --list-optional: terms not scanned`);
  else if (neverMode) listProblem.push(...neverListProblemFindings(loaded));
  else listProblem.push(...publicListProblemFindings(loaded));
}
const matcher = list
  ? new ConfidentialTermMatcher(
      list.salt,
      list.maxTokens,
      neverMode ? neverBadTermSet(list) : publicBadTermSet(list),
    )
  : undefined;

/** `inPath`: `texts` is the path `where` itself. Several texts are scanned apart; a name is one finding. */
function scanText(where: string, texts: string | string[], inPath = false) {
  if (!matcher) return;
  const items = [texts].flat();
  const found = neverMode ? matcher.matchNeverTexts(items) : matcher.matchPublicTexts(items);
  for (const name of found) {
    if (neverMode)
      findings.push(inPath ? neverPathFinding(where, name) : neverTermFinding(where, name));
    else findings.push(inPath ? publicPathFinding(where, name) : publicTermFinding(where, name));
  }
}

function scanBinaries(files: BinaryFile[]) {
  if (!files.length) return;
  if (skipped) {
    findings.push(...agentWorkCiFindings(files));
    return;
  }
  const onMissingTool = unscanned
    ? (where: string, entry: string, why: string) =>
        warn(`${where}${entry && ` (${entry})`}: ${why}; --list-optional: passed unread`)
    : report;
  const texts = new BinaryContentScanner(CACHE_DIR, report, onMissingTool).scanAll(
    files,
    READER_SOURCES,
    OCR_SOURCE,
  );
  for (const [where, text] of texts) {
    const nav = detectCompanyOsNav(text);
    if (nav.length >= 3)
      report(
        where,
        nav.join(", "),
        "Company OS screenshot: remove this internal Company OS image from the public repository and replace it with an invented diagram or anonymised mockup; do not silence with scaffolding.allow",
      );
    scanText(where, text);
  }
}

let full = false;
/** The blobs `names` (a SHA, `:<path>`, `<rev>:<path>`) name, by one cat-file: a `git show` per
 * file cost 6.6 ms each. An error names the file by its path in `paths`. */
function objects(names: string[], paths: string[]): Buffer[] {
  if (!names.length) return [];
  return parseCatFileBatch(git(["cat-file", "--batch"], root, names.join("\n") + "\n"), paths);
}

const binaries: BinaryFile[] = [];
let lfsStores: string[] | undefined;

/** The file a Git LFS pointer names, from the working tree where it matches the pointer's oid,
 * else from the local LFS store; undefined where neither holds it. */
function lfsContent(where: string, pointer: Buffer): Buffer | undefined {
  const parsed = parseLfsPointer(pointer);
  if (!parsed) return undefined;
  lfsStores ??= lfsObjectDirs(root);
  const at = join(parsed.oid.slice(0, 2), parsed.oid.slice(2, 4), parsed.oid);
  const candidates = [join(root, where), ...lfsStores.map((dir) => join(dir, at))];
  return readLfsContent(candidates, parsed);
}

const take = (where: string, data: Buffer) => {
  if (isLfsPointer(data)) {
    const content = lfsContent(where, data);
    if (!content) return console.error(`[check-confidential] ${where}: Git LFS pointer, not read`);
    data = content;
  }
  binaries.push({ where, data });
};

function scanDiffMode(): void {
  const range = commit
    ? ["show", "--format=", "--no-renames", commit]
    : ["diff", "--cached", "--no-renames"];
  // No user setting may change what the scan sees: a textconv driver's text in place of a binary,
  // or a submodule's log, which has no "diff --git" header and shifts every later file's lines.
  const options = [
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules",
    "--diff-filter=AM",
  ];
  const files = parseNumstatEntries(
    git([...range, ...options, "--numstat", "-z"], root).toString(),
  );
  const paths = files.map((file) => file.path);
  for (const path of paths) scanText(path, path, true);
  const texts = addedLines(git([...range, ...options, "-U0"], root).toString(), paths);
  const binary = new Set(
    files.filter((file) => file.binary || isBinaryExtension(file.path)).map((file) => file.path),
  );
  // A Git LFS pointer is text to git, and its oid line changes with the file it names.
  const toRead = paths.filter(
    (path) => binary.has(path) || texts.get(path)?.some((line) => LFS_OID_PATTERN.test(line)),
  );
  const data = objects(
    toRead.map((path) => `${commit ?? ""}:${path}`),
    toRead,
  );
  const taken = new Set<string>();
  toRead.forEach((path, idx) => {
    if (!binary.has(path) && !isLfsPointer(data[idx])) return;
    taken.add(path);
    take(path, data[idx]);
  });
  for (const path of paths)
    if (!taken.has(path)) scanText(path, ownText(path, texts.get(path)?.join("\n") ?? ""));
  if (commit)
    scanText("commit message", git(["log", "-1", "--format=%B", commit], root).toString());
}

function scanNeverMode(): void {
  const texts = parseNeverInput(readFileSync(0, "utf8"));
  // Kept out of the allow check like the list's own problems: a broken dump passes nothing.
  if (!texts) {
    listProblem.push({
      check: CHECK,
      path: "stdin",
      text: "",
      message:
        'nothing to scan: stdin holds no {"<where>": <value>} object, each value a string or JSON holding one. Pipe a non-empty JSON object mapping each source key to its string or nested JSON text into `check-confidential never`',
    });
    return;
  }
  full = true;
  // A key may be a slug the deck shows in its address. Each string apart, so two never join into
  // a name neither shows.
  for (const [where, text] of texts) scanText(where, [where, ...text]);
}

function scanSnapshotMode(): void {
  full = true;
  const output = git(
    tree ? ["ls-tree", "-r", "-z", tree] : ["ls-files", "-s", "-z"],
    root,
  ).toString();
  const entries = tree ? parseTreeEntries(output) : readCleanIndexEntries(output);
  for (const { path } of entries) scanText(path, path, true);
  const blobs = entries.filter((entry) => entry.type === "blob");
  const data = objects(
    blobs.map((entry) => entry.sha),
    blobs.map((entry) => entry.path),
  );
  blobs.forEach(({ path }, idx) => {
    if (isBinaryExtension(path) || data[idx].includes(0) || isLfsPointer(data[idx]))
      take(path, data[idx]);
    else scanText(path, ownText(path, data[idx].toString("utf8")));
  });
}

function readCleanIndexEntries(output: string) {
  const parsed = parseIndexEntries(output);
  if (parsed.unmergedPath) {
    console.error(
      `[check-confidential] ${parsed.unmergedPath}: unmerged; resolve the merge, then scan the index`,
    );
    process.exit(1);
  }
  return parsed.entries;
}

// Comment lines count: `git commit -m` keeps them. Only the diff below `commit -v`'s scissors goes.
if (message) scanText("commit message", readFileSync(message, "utf8").split(/^# -+ >8 -+$/m)[0]);
else if (argv.includes("--staged") || commit) scanDiffMode();
else if (neverMode) scanNeverMode();
else if (tree || index) scanSnapshotMode();
else exitWithResult({ stderr: USAGE, exitCode: 2 });
scanBinaries(binaries);

// A full scan (the index, the gate's step, a tree, or the never scan, handed every string the caller
// shows) sees every case, so an allow entry matching nothing there is stale. A partial scan (staged, one commit, a message) or one without the list
// cannot tell.
const allowedFindings =
  full && list ? auditAllow(pkg, CHECK, findings) : applyAllow(pkg, CHECK, findings);
finish("check-confidential", [...listProblem, ...allowedFindings], started);
