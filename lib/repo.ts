import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** A company repository's remote; the tests point SCAFFOLDING_GIT_BASE at local stand-ins. */
export const companyRemote = (repo: string) =>
  `${process.env.SCAFFOLDING_GIT_BASE || "https://github.com/hackersandwizards/"}${repo}.git`;

/** The highest v<major>.<minor>.<patch> tag `remote` holds, or undefined where none is read within
 * SCAFFOLDING_FETCH_WAIT_S seconds (20 by default): an SSH remote waits for a person to approve
 * the key, and nothing in ssh or git ends that wait. git runs in a process group of its own, so the
 * timeout ends ssh with it. git's own error goes to stderr. */
export async function newestTag(remote: string): Promise<string | undefined> {
  const wait = Number(process.env.SCAFFOLDING_FETCH_WAIT_S) || 20;
  const git = spawn("git", ["ls-remote", "--tags", "--refs", remote], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  let out = "";
  git.stdout.on("data", (chunk) => (out += chunk));
  const timer = setTimeout(() => {
    console.error(`git ls-remote ${remote}: no answer within ${wait} s`);
    try {
      process.kill(-git.pid!, "SIGTERM");
    } catch {} // the group is already gone
  }, wait * 1000);
  const code = await new Promise<number | null>((done) => {
    git.on("error", () => done(null));
    git.on("close", done);
  });
  clearTimeout(timer);
  if (code !== 0) return undefined;
  return out
    .split("\n")
    .map((line) => line.split("refs/tags/")[1])
    .filter((tag): tag is string => /^v\d+\.\d+\.\d+$/.test(tag ?? ""))
    .sort((a, b) => Bun.semver.order(a.slice(1), b.slice(1)))
    .at(-1);
}

export const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
/**
 * Runs this command again under the checkout's lock with `--locked` appended, and exits as that run
 * does; the run carrying `--locked` returns at once and goes on. A signal here goes on to
 * check-lock, which passes it to the locked run's group and holds the lock until that group is
 * empty: ending this process alone left the run going and the lock held.
 */
export async function underLock(root: string, args: string[]): Promise<void> {
  if (process.argv.includes("--locked")) return;
  const lock = spawn(
    process.execPath,
    [
      join(import.meta.dir, "..", "template/.githooks/check-lock.ts"),
      process.execPath,
      process.argv[1]!,
      ...args,
      "--locked",
    ],
    // A group of its own: a terminal's Ctrl-C reaches this process alone, which passes it on once;
    // reaching check-lock as well, the second copy read as a second signal and killed the run.
    { stdio: "inherit", cwd: root, detached: true },
  );
  for (const signal of SIGNALS) process.on(signal, () => lock.kill(signal));
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done) =>
    lock.on("exit", (...end) => done(end)),
  );
  // Dying by the signal tells the calling shell it was an interrupt.
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
  process.exit(code ?? 1);
}

/** The commit the package at `home` came from, read offline: the SHA bun writes to .bun-tag for a
 * Git dependency (a GitHub tarball's "<owner>-<repo>-<short SHA>", a clone's bare SHA), else the
 * HEAD of the package's own checkout, which its tests run from; undefined for any other install. */
export function installedCommit(home: string): string | undefined {
  const tag = join(home, ".bun-tag");
  if (existsSync(tag))
    return /(?:^|-)([0-9a-f]{7,40})$/.exec(readFileSync(tag, "utf8").trim())?.[1];
  const r = spawnSync("git", ["rev-parse", "--show-toplevel", "HEAD"], {
    cwd: home,
    encoding: "utf8",
  });
  const [top, head] = (r.stdout ?? "").trim().split("\n");
  return r.status === 0 && top && realpathSync(top) === realpathSync(home) ? head : undefined;
}

/** The full commit of this package's tag v<version>, which must be the `installed` one: a short
 * SHA asks the remote, peeled for an annotated tag. Throws where the remote is not read or the
 * tag points elsewhere, which means it moved after the install. */
export function tagCommit(version: string, installed: string | undefined): string {
  if (!installed)
    throw new Error("no installed commit to pin: install the package from its Git tag");
  if (/^[0-9a-f]{40}$/.test(installed)) return installed;
  const remote = companyRemote("scaffolding");
  const tag = `refs/tags/v${version}`;
  const r = spawnSync("git", ["ls-remote", remote, tag, `${tag}^{}`], { encoding: "utf8" });
  const refs = new Map(
    (r.stdout ?? "")
      .trim()
      .split("\n")
      .map((line) => line.split("\t").reverse() as [string, string]),
  );
  const sha = refs.get(`${tag}^{}`) ?? refs.get(tag);
  if (r.status !== 0 || !sha)
    throw new Error(`v${version} not read from ${remote}: ${r.stderr ?? ""}`.trim());
  if (!sha.startsWith(installed))
    throw new Error(`v${version} points at ${sha}, installed is ${installed}: the tag moved`);
  return sha;
}

/** A file's comments, by its kind: `#` lines for shell, Python, YAML, TOML, Git hooks and the
 * editor and Prettier ignore files, else block, HTML and `//` comments, a `//` in a URL or a
 * string's start excepted. A block comment opens only after a character that ends code or another
 * comment, or after a word when a space follows the mark: a glob such as "src/*.ts" would read on
 * to the next closing mark. Group 1 is what a replacement keeps: the character before a comment,
 * or, outside Markdown, HTML and templates, whose apostrophes are prose, a quoted string on one line, matched
 * as itself so that "x//y" or "issue #12" no longer dropped the code after it as a comment. */
export const commentSyntax = (path: string) => {
  const quoted = /\.(?:md|mdx|html?|astro|[jt]sx|vue|svelte)$/.test(path)
    ? ""
    : String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`;
  // After a string, the lookbehind ends the match at its closing quote.
  return /\.(?:sh|py|ya?ml|toml)$|(?:^|\/)(?:\.githooks\/[^/.]+|\.editorconfig|\.prettierignore)$/.test(
    path,
  )
    ? new RegExp(String.raw`(${quoted}^|\s)(?:(?<=["'])|#.*)`, "gm")
    : new RegExp(
        String.raw`(${quoted}^|[\s{};,)>]|\b(?=\/\*\s)|(?<=\*\/))(?:(?<=["'])|\/\*[\s\S]*?\*\/)|<!--[\s\S]*?-->|(?<![:"'` +
          "`" +
          String.raw`\\])\/\/.*`,
        "gm",
      );
};

/** Every file path an `exports` value names, a conditional export's included. */
export const exportTargets = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(exportTargets)
      : [];

/** The files check-coupling and check-unique-names count as tests, as config/eslint.js globs them. */
export const TEST = /(?:^|\/)(?:__tests__|tests?|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Exits 2 unless this bun started with `--no-env-file`, and hands the flag to every bun a step
 * starts (docs/gate.md: Environment). */
export function withoutEnvFile(name: string) {
  if (!process.execArgv.includes("--no-env-file")) {
    console.error(`[${name}] run it as its bin or with \`bun --no-env-file\`, so .env stays out`);
    process.exit(2);
  }
  const options = process.env.BUN_OPTIONS ?? "";
  if (!options.split(/\s+/).includes("--no-env-file"))
    process.env.BUN_OPTIONS = `--no-env-file ${options}`.trim();
}

/** A reason is a non-blank string, so `false`, `0` or `{}` in package.json gives none. */
export const isReason = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/** The files the styles step lints, and stylelint's arguments past them, shared by the gate and the
 * hook so both judge the same files. The repository's own config governs every file, so a nested
 * repository's config (a submodule's) never takes over its files and the root config's ignoreFiles
 * holds. One line per finding: the default formatter's table threw "Subject parameter value width"
 * in a run with findings, and a plain line format has no table. */
export const styleFiles = "**/*.{css,astro}";
const styleGlob = new Bun.Glob(styleFiles);
// The gate's glob skips dot folders, dot files and node_modules; a staged path is named explicitly.
export const styled = (path: string) =>
  styleGlob.match(path) && !/(^|\/)(\.|node_modules\/)/.test(path);
export { submodulePaths } from "../config/submodules.js";

export const stylelintFlags = (root: string) => [
  ...(existsSync(join(root, "stylelint.config.js")) ? ["--config", "stylelint.config.js"] : []),
  "--allow-empty-input",
  "--ignore-path",
  ".gitignore",
  "--formatter",
  "compact",
];

/** `term`: the text is a bare term, which an allow entry names whole. */
/** `name`: the term stands in the file's path, the one finding an entry with "file names" covers. */
export type Finding = {
  check: string;
  path: string;
  text: string;
  message: string;
  term?: true;
  name?: true;
};
type AllowEntry = {
  check?: string;
  path?: string | string[];
  text?: string | string[];
  reason?: unknown;
};

export function git(args: string[], cwd = process.cwd(), input?: string): Buffer {
  const r = spawnSync("git", args, { cwd, input, maxBuffer: Infinity });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

export const repoRoot = (cwd = process.cwd()) =>
  git(["rev-parse", "--show-toplevel"], cwd).toString().trim();

/**
 * The working tree's files, tracked and untracked but not ignored, so a file the next commit adds
 * is judged before the commit hook sees it; with `staged`, the added, copied, modified and renamed
 * paths in the index, a submodule's commit left out.
 */
export function listFiles(root: string, staged: boolean): string[] {
  const args = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "--ignore-submodules", "-z"]
    : ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"];
  const files = git(args, root).toString().split("\0").filter(Boolean);
  return staged ? files : files.filter((path) => existsSync(`${root}/${path}`));
}

/** A staged file is read from the index, so unstaged lines neither pass nor block the commit. */
export const reader = (root: string, staged: boolean) => (path: string) =>
  staged ? git(["show", `:${path}`], root) : readFileSync(`${root}/${path}`);

export type Package = {
  type?: string;
  packageManager?: string;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scaffolding?: {
    allow?: AllowEntry[];
    private?: boolean;
    typecheck?: string;
    test?: string;
    uniqueNames?: string[];
    skip?: Record<string, unknown>;
    check?: (string | string[])[];
    styles?: string[];
    licenses?: Record<string, { license?: string; reason?: unknown }>;
  };
  [field: string]: unknown;
};

/**
 * A repository without package.json reads as empty; check-structure reports it missing. With `rev`,
 * the file as that snapshot holds it: `:` the index, else a commit or tree. A bad revision or an
 * unmerged package.json throws rather than read as empty, which would drop every allow entry.
 */
export function readPackage(root: string, rev?: string): Package {
  if (rev === undefined) {
    const file = `${root}/package.json`;
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }
  const index = rev === ":";
  const listed = git(index ? ["ls-files", "package.json"] : ["ls-tree", rev, "package.json"], root);
  if (!listed.length) return {};
  return JSON.parse(git(["show", `${index ? "" : rev}:package.json`], root).toString("utf8"));
}

// `**/` also stands for no folder at all, as in Git and Bun.Glob: `**/x.ts` covers the root's x.ts.
const glob = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split(/(\*\*\/?)/)
      .map((part) =>
        part === "**/"
          ? "(?:.*/)?"
          : part === "**"
            ? ".*"
            : part
                .split("*")
                .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
                .join("[^/]*"),
      )
      .join("")}$`,
  );

// Folded as the confidential scan reads text: NFKC words joined by one space, in lower case.
const fold = (s: string) =>
  (s.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).join(" ").toLowerCase();

// A longer term containing the entry's ("<name> Consulting") stays red.
const textCovers = (text: string, f: Finding) =>
  f.term ? fold(f.text) === fold(text) : f.text.includes(text);

// "file names" in `path` keeps the entry to terms in a file's path: alone in every file, beside
// paths in those files only, so a term in the same files' text stays red.
const NAMES = "file names";
const covers = (entry: AllowEntry, f: Finding, text = entry.text) => {
  const paths = entry.path === undefined ? [] : [entry.path].flat();
  const globs = paths.filter((p) => p !== NAMES);
  return (
    entry.check === f.check &&
    (!paths.includes(NAMES) || f.name === true) &&
    (!globs.length || globs.some((p) => glob(p).test(f.path))) &&
    (text === undefined || [text].flat().some((t) => textCovers(t, f)))
  );
};

/**
 * Drops each finding a `scaffolding.allow` entry of `pkg` covers, and reports every entry of this
 * check without a reason. `pkg` is the package.json of the snapshot the findings come from, so a
 * commit adding a case and its entry together is judged as one. With `stale`, a full run also
 * reports every entry that covers nothing, so an exception dies with the case it was written for.
 */
export function applyAllow(
  pkg: Package,
  check: string,
  findings: Finding[],
  stale: boolean,
): Finding[] {
  const allow: AllowEntry[] = pkg.scaffolding?.allow ?? [];
  // A path or text that is not a string, or a list of strings, threw inside the match.
  const text = (v: unknown) =>
    v === undefined ||
    typeof v === "string" ||
    (Array.isArray(v) && v.every((x) => typeof x === "string"));
  const mine = allow.filter((e) => e.check === check);
  const usable = mine.filter((e) => text(e.path) && text(e.text));
  const left = findings.filter((f) => !usable.some((e) => covers(e, f)));
  const report = (e: AllowEntry, message: string) =>
    left.push({ check, path: "package.json", text: JSON.stringify(e), message });
  for (const e of mine) {
    if (!usable.includes(e))
      report(e, "allow entry's path and text are strings or lists of strings");
    else if (!isReason(e.reason)) report(e, "allow entry without a reason");
    else if (stale && !findings.some((f) => covers(e, f))) report(e, "allow entry matches nothing");
    else if (stale) {
      // Each text and each path of a list is its own exception and dies with its own case.
      const items = (v: string | string[] | undefined) => (Array.isArray(v) ? v : []);
      // "file names" qualifies the paths beside it, which each keep it.
      const names = items(e.path).includes(NAMES) ? [NAMES] : [];
      for (const path of items(e.path).filter((p) => p !== NAMES))
        if (!findings.some((f) => covers({ ...e, path: [...names, path] }, f)))
          report({ ...e, path }, "allow entry matches nothing");
      for (const t of items(e.text))
        if (!findings.some((f) => covers(e, f, t)))
          report({ ...e, text: t }, "allow entry matches nothing");
    }
  }
  return left;
}

export function finish(check: string, findings: Finding[], started: number): never {
  for (const f of findings)
    console.error(`[${check}] ${f.path}: ${f.message}${f.text ? ` (${f.text})` : ""}`);
  const ms = Math.round(performance.now() - started);
  if (findings.length) console.error(`[${check}] ${findings.length} findings, ${ms} ms`);
  process.exit(findings.length ? 1 : 0);
}

/** The files a consumer installs, as `bun pm pack` lists them; none where package.json declares no
 * files, exports or bin, since such a repository ships nothing another repository reads. Exits 1
 * where pack fails. */
export function shippedFiles(root: string, pkg: Package, check: string): string[] {
  if (!pkg.files && !pkg.exports && !pkg.bin) return [];
  const pack = spawnSync(process.execPath, ["pm", "pack", "--dry-run", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  });
  const shipped = (pack.stdout ?? "")
    .split("\n")
    .flatMap((l) => l.match(/^packed \S+ (.+)$/)?.[1] ?? []);
  // package.json always ships, so an empty list means pack failed or changed its output.
  if (pack.status !== 0 || !shipped.length) {
    console.error(`[${check}] bun pm pack listed no files: ${pack.stderr ?? pack.error}`);
    process.exit(1);
  }
  return shipped;
}
