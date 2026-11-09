import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A file's comments, by its kind: `#` lines for shell, Python, YAML, TOML, Git hooks and the
 * editor and Prettier ignore files, else block, HTML and `//` comments, a `//` in a URL or a
 * string's start excepted. A block comment opens only after a character that ends code or another
 * comment, or after a word when a space follows the mark: a regular expression cannot tell a string
 * from code, and a glob such as "src/*.ts" would read on to the next closing mark. Group 1 is the character before
 * a comment that a replacement keeps. */
export const commentSyntax = (path: string) =>
  /\.(?:sh|py|ya?ml|toml)$|(?:^|\/)(?:\.githooks\/[^/.]+|\.editorconfig|\.prettierignore)$/.test(
    path,
  )
    ? /(^|\s)#.*/gm
    : /(^|[\s{};,)>]|\b(?=\/\*\s)|(?<=\*\/))\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(?<![:"'`\\])\/\/.*/gm;

/** Exits 2 unless this bun started with `--no-env-file`, and hands the flag to every bun a step
 * starts (README: Environment). */
export function withoutEnvFile(name: string) {
  if (!process.execArgv.includes("--no-env-file")) {
    console.error(`[${name}] run it as its bin or with \`bun --no-env-file\`, so .env stays out`);
    process.exit(2);
  }
  process.env.BUN_OPTIONS = `--no-env-file ${process.env.BUN_OPTIONS ?? ""}`.trim();
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
export const stylelintFlags = (root: string) => [
  ...(existsSync(join(root, "stylelint.config.js")) ? ["--config", "stylelint.config.js"] : []),
  "--allow-empty-input",
  "--ignore-path",
  ".gitignore",
  "--formatter",
  "compact",
];

/** `term`: the text is a bare term, which an allow entry names whole. */
export type Finding = { check: string; path: string; text: string; message: string; term?: true };
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
 * paths in the index.
 */
export function listFiles(root: string, staged: boolean): string[] {
  const args = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
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
  scaffolding?: {
    allow?: AllowEntry[];
    private?: boolean;
    typecheck?: string;
    test?: string;
    uniqueNames?: string[];
    skip?: Record<string, unknown>;
    check?: (string | string[])[];
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

const glob = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split("**")
      .map((part) =>
        part
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*")}$`,
  );

// Folded as the confidential scan reads text: NFKC words joined by one space, in lower case.
const fold = (s: string) =>
  (s.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).join(" ").toLowerCase();

// A longer term containing the entry's ("<name> Consulting") stays red.
const textCovers = (text: string, f: Finding) =>
  f.term ? fold(f.text) === fold(text) : f.text.includes(text);

const covers = (entry: AllowEntry, f: Finding, text = entry.text) =>
  entry.check === f.check &&
  (entry.path === undefined || [entry.path].flat().some((p) => glob(p).test(f.path))) &&
  (text === undefined || [text].flat().some((t) => textCovers(t, f)));

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
  const mine = allow.filter((e) => e.check === check);
  const left = findings.filter((f) => !mine.some((e) => covers(e, f)));
  for (const e of mine) {
    if (!isReason(e.reason))
      left.push({
        check,
        path: "package.json",
        text: JSON.stringify(e),
        message: "allow entry without a reason",
      });
    else if (stale)
      // Each text and each path of a list is its own exception and dies with its own case.
      for (const text of Array.isArray(e.text) && e.text.length ? e.text : [e.text])
        for (const path of Array.isArray(e.path) && e.path.length ? e.path : [e.path])
          if (!findings.some((f) => covers({ ...e, path }, f, text)))
            left.push({
              check,
              path: "package.json",
              text: JSON.stringify({ ...e, path, text }),
              message: "allow entry matches nothing",
            });
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
