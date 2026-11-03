import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export type Finding = { check: string; path: string; text: string; message: string };
type AllowEntry = { check?: string; path?: string; text?: string; reason?: string };

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
    skip?: Record<string, string>;
    check?: (string | string[])[];
    licenses?: Record<string, { license?: string; reason?: string }>;
  };
  [field: string]: unknown;
};

/** A repository without package.json reads as empty; check-structure reports it missing. */
export function readPackage(root: string): Package {
  const file = `${root}/package.json`;
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
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

const covers = (entry: AllowEntry, f: Finding) =>
  entry.check === f.check &&
  (entry.path === undefined || glob(entry.path).test(f.path)) &&
  (entry.text === undefined || f.text.includes(entry.text));

/**
 * Drops each finding a `scaffolding.allow` entry of package.json covers, and reports every entry
 * of this check without a reason. With `stale`, a full run also reports every entry that covers
 * nothing, so an exception dies with the case it was written for.
 */
export function applyAllow(
  root: string,
  check: string,
  findings: Finding[],
  stale: boolean,
): Finding[] {
  const allow: AllowEntry[] = readPackage(root).scaffolding?.allow ?? [];
  const mine = allow.filter((e) => e.check === check);
  const left = findings.filter((f) => !mine.some((e) => covers(e, f)));
  for (const e of mine) {
    if (!e.reason?.trim())
      left.push({
        check,
        path: "package.json",
        text: JSON.stringify(e),
        message: "allow entry without a reason",
      });
    else if (stale && !findings.some((f) => covers(e, f)))
      left.push({
        check,
        path: "package.json",
        text: JSON.stringify(e),
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
