import type { AllowEntry } from "./allow-entries.ts";
import { fetchWaitS } from "./repo-inputs.ts";
import { jsonObject } from "./json.ts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** A company repository's remote; the tests point SCAFFOLDING_GIT_BASE at local stand-ins. */
export const companyRemote = (repo: string) =>
  `${process.env.SCAFFOLDING_GIT_BASE || "https://github.com/hackersandwizards/"}${repo}.git`;

/** The highest v<major>.<minor>.<patch> tag `remote` holds, or undefined where none is read within
 * fetchWaitS() seconds: an SSH remote waits for a person to approve the key, and nothing in ssh or
 * git ends that wait. git runs in a process group of its own, so the timeout ends ssh with it.
 * git's own error goes to stderr. */
export async function newestTag(remote: string): Promise<string | undefined> {
  const wait = fetchWaitS();
  const git = spawn("git", ["ls-remote", "--tags", "--refs", remote], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  let out = "";
  git.stdout.on("data", (chunk) => (out += chunk));
  const result = Promise.withResolvers<number | null>();
  git.on("error", () => result.resolve(null));
  git.on("close", result.resolve);
  const timer = setTimeout(() => {
    console.error(
      `git ls-remote ${remote}: no answer within ${wait} s, so the latest release tag is unknown. Check access to the remote, or increase SCAFFOLDING_FETCH_WAIT_S if the connection is slow.`,
    );
    if (git.pid === undefined) return;
    try {
      process.kill(-git.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") result.reject(error);
    }
  }, wait * 1000);
  const code = await result.promise.finally(() => clearTimeout(timer));
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
  const entry = process.argv[1];
  if (!entry) throw new Error("underLock: cannot resolve entry script from process.argv[1]");
  const lock = spawn(
    process.execPath,
    [
      join(import.meta.dir, "..", "template/.githooks/check-lock.ts"),
      process.execPath,
      entry,
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
    throw new Error(
      `v${version} could not be read from ${remote}, so the Pages workflow cannot be pinned (${(r.stderr ?? "").trim() || "tag not found"}). Restore access to the remote or install the package from a published Git tag.`,
    );
  if (!sha.startsWith(installed))
    throw new Error(
      `v${version} points at ${sha}, installed is ${installed}, so the installed commit cannot pin the Pages workflow to that tag. Reinstall the package from the Git tag you intend to use.`,
    );
  return sha;
}

/** The files check-coupling counts as tests, as config/eslint.js globs them. */
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

export { submodulePaths } from "../config/submodules.js";

// Use the root config for nested files and compact output to avoid the default formatter's width error.
export const stylelintFlags = (root: string) => [
  ...(existsSync(join(root, "stylelint.config.js")) ? ["--config", "stylelint.config.js"] : []),
  "--allow-empty-input",
  "--ignore-path",
  ".gitignore",
  "--custom-formatter",
  join(import.meta.dir, "stylelint-formatter.ts"),
];

/** `term`: the text is a bare term, which an allow entry names whole. */
/** `name`: the term stands in the file's path, the one finding an entry with "file names" covers. */
export type Finding = {
  check: string;
  path: string;
  text: string;
  message: string;
  prefix?: string;
  term?: true;
  name?: true;
};

export class GitCommandError extends Error {}

export function throwGitCommandFailure(
  result: { status: number | null; error?: Error },
  message: string,
): never {
  if (result.status === null) throw result.error ?? new Error(message);
  throw new GitCommandError(message);
}

export function git(args: string[], cwd = process.cwd(), input?: string): Buffer {
  const r = spawnSync("git", args, { cwd, input, maxBuffer: Infinity });
  if (r.status !== 0) throwGitCommandFailure(r, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

export function resolveModuleIfAvailable(specifier: string, directory: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return undefined;
  }
}

// Chunked: a commit touching most of a repository passes more path bytes than ARG_MAX holds.
export function pathChunks(paths: string[]) {
  const chunks: string[][] = [[]];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (bytes + size > 100_000) {
      chunks.push([]);
      bytes = 0;
    }
    chunks[chunks.length - 1].push(path);
    bytes += size;
  }
  return chunks;
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

export { isObject, isStrings, jsonObject } from "./json.ts";
export { commentSyntax, exportTargets, fetchWaitS, ourRepository, styled } from "./repo-inputs.ts";

export type Package = {
  name?: string;
  type?: string;
  packageManager?: string;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scaffolding?: {
    allow?: AllowEntry[];
    private?: boolean;
    typecheck?: string;
    test?: string;
    browserTest?: string;
    markdown?: { content?: string[] };
    brand?: {
      directory?: string;
      retired?: string[];
      elements?: "server";
    };
    server?: { command: string; timeout?: number; stderr?: boolean };
    linkSkips?: string[];
    skip?: Record<string, unknown>;
    check?: (string | string[])[];
    styles?: string[];
    licenses?: Record<string, { license?: string; reason?: unknown }>;
    changed?: Record<string, string[]>;
    fullOnly?: Record<string, unknown>;
    deploy?: string[];
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
    return existsSync(file) ? jsonObject(readFileSync(file)) : {};
  }
  const index = rev === ":";
  const listed = git(index ? ["ls-files", "package.json"] : ["ls-tree", rev, "package.json"], root);
  if (!listed.length) return {};
  return jsonObject(git(["show", `${index ? "" : rev}:package.json`], root));
}

export function printCheckFindings(check: string, findings: Finding[], started: number) {
  for (const f of findings)
    console.error(`[${f.prefix ?? check}] ${f.path}: ${f.message}${f.text ? ` (${f.text})` : ""}`);
  const ms = Math.round(performance.now() - started);
  if (findings.length) console.error(`[${check}] ${findings.length} findings, ${ms} ms`);
}

export function finish(check: string, findings: Finding[], started: number): never {
  printCheckFindings(check, findings, started);
  process.exit(findings.length ? 1 : (process.exitCode ?? 0));
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
    console.error(
      `[${check}] bun pm pack listed no files, so the check cannot tell what ships (${pack.stderr ?? pack.error}). Fix the package.json or packaging error shown and verify with bun pm pack --dry-run --ignore-scripts.`,
    );
    process.exit(1);
  }
  return shipped;
}
