import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git as readGit, GitCommandError } from "./repo.ts";
import { gitShellScripts, needsShellShebang, shellInput, shellSources } from "./shell-inputs.ts";
import { indexInputs, inNodeModules, regularInput, treeInputs } from "./tracked-inputs.ts";

export type ChangedFilesResult =
  | {
      paths: Set<string>;
      shellShebangs: Set<string>;
      sourcedPaths: Set<string>;
      since: string;
    }
  | { fallback: string };

function runGitText(root: string, args: readonly string[]) {
  return spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
}

export function parseNulPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

export function readShellTreeInputs(
  root: string,
  ref: string,
): { shebangs: string[]; sourced: string[] } {
  const tracked = treeInputs(root, ref);
  const scripts = gitShellScripts(root, tracked, ref);
  const shebangs = scripts.filter(needsShellShebang);
  const sourced = [
    ...shellSources(scripts, tracked, (path) => readGit(["show", `${ref}:${path}`], root)),
  ];
  return { shebangs, sourced };
}

export function verifyCommitRange(
  root: string,
  range: string,
): { base: string; head: string } | { fallback: string } {
  const [from, to] = range.split("..") as [string, string];
  if (/^0+$/.test(from)) return { fallback: `${range} starts a new branch` };
  const old = runGitText(root, ["rev-parse", "--verify", "--end-of-options", `${from}^{commit}`]);
  const next = runGitText(root, ["rev-parse", "--verify", "--end-of-options", `${to}^{commit}`]);
  if (old.status !== 0) return { fallback: `${range} starts at a commit this clone lacks` };
  if (next.status !== 0) return { fallback: `${range} ends at a commit this clone lacks` };
  const base = old.stdout.trim();
  const head = next.stdout.trim();
  const ancestor = runGitText(root, ["merge-base", "--is-ancestor", base, head]);
  if (ancestor.status !== 0) return { fallback: `${range} is not a verifiable fast-forward` };
  return { base, head };
}

function diffNameOnly(root: string, revs: readonly string[]) {
  return runGitText(root, [
    "diff",
    "--name-only",
    "--no-renames",
    "--ignore-submodules=none",
    "-z",
    ...revs,
    "--",
  ]);
}

export function resolveRangePaths(
  root: string,
  range: string,
): { base: string; head: string; touched: string[] } | { fallback: string } {
  const resolved = verifyCommitRange(root, range);
  if ("fallback" in resolved) return resolved;
  const diff = diffNameOnly(root, [resolved.base, resolved.head]);
  if (diff.status !== 0) return { fallback: "git could not list the changes" };
  return { base: resolved.base, head: resolved.head, touched: parseNulPaths(diff.stdout) };
}

export function formatSince(ranges: readonly string[]): string {
  return ranges.map((r) => r.split("..")[0].slice(0, 9)).join(", ");
}

export function collectShellRefs(
  root: string,
  refs: readonly string[],
): { shebangs: string[]; sourced: string[] } {
  const shebangs: string[] = [];
  const sourced: string[] = [];
  for (const ref of refs) {
    const inputs = readShellTreeInputs(root, ref);
    shebangs.push(...inputs.shebangs);
    sourced.push(...inputs.sourced);
  }
  return { shebangs, sourced };
}

export function collectRangeChanges(root: string, ranges: readonly string[]): ChangedFilesResult {
  const paths = new Set<string>();
  for (const range of ranges) {
    const resolved = resolveRangePaths(root, range);
    if ("fallback" in resolved) return resolved;
    for (const path of resolved.touched) paths.add(path);
  }
  return {
    paths,
    shellShebangs: new Set(),
    sourcedPaths: new Set(),
    since: formatSince(ranges),
  };
}

export function collectRangeChangesWithShell(
  root: string,
  ranges: readonly string[],
): ChangedFilesResult {
  const paths = new Set<string>();
  const shellShebangs = new Set<string>();
  const sourcedPaths = new Set<string>();
  const seenRefs = new Set<string>();
  for (const range of ranges) {
    const resolved = resolveRangePaths(root, range);
    if ("fallback" in resolved) return resolved;
    for (const path of resolved.touched) paths.add(path);
    if (!resolved.touched.length) continue;
    const refs = [...new Set([resolved.base, resolved.head])].filter((ref) => !seenRefs.has(ref));
    for (const ref of refs) seenRefs.add(ref);
    try {
      const inputs = collectShellRefs(root, refs);
      for (const path of inputs.shebangs) shellShebangs.add(path);
      for (const path of inputs.sourced) sourcedPaths.add(path);
    } catch (error) {
      if (!(error instanceof GitCommandError)) throw error;
      return { fallback: "git could not read shell inputs in the pushed ranges" };
    }
  }
  return { paths, shellShebangs, sourcedPaths, since: formatSince(ranges) };
}

const unavailableShellPaths = new Set(["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM"]);
class ShellInputUnavailable extends Error {}

function readWorkingShellInput<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (unavailableShellPaths.has((error as NodeJS.ErrnoException)?.code ?? ""))
      throw new ShellInputUnavailable("could not read a working-tree shell input", {
        cause: error,
      });
    throw error;
  }
}

export function readWorkingTreeShellInputs(
  root: string,
  base: string,
  changedPaths: ReadonlySet<string>,
): { shellShebangs: Set<string>; sourcedPaths: Set<string> } {
  const baseShell = readShellTreeInputs(root, base);
  const shellShebangs = new Set<string>(baseShell.shebangs);
  const sourcedPaths = new Set<string>(baseShell.sourced);
  const regular = (path: string) => readWorkingShellInput(() => regularInput(root, path));
  const shell = (path: string) => readWorkingShellInput(() => shellInput(path, join(root, path)));
  const read = (path: string) => readWorkingShellInput(() => readFileSync(join(root, path)));
  const tracked = indexInputs(root).filter(regular);
  const scripts = tracked.filter(shell);
  for (const path of shellSources(scripts, tracked, read)) sourcedPaths.add(path);
  for (const path of changedPaths) {
    if (inNodeModules(path) || !needsShellShebang(path)) continue;
    if (regular(path) && shell(path)) shellShebangs.add(path);
  }
  return { shellShebangs, sourcedPaths };
}

function collectWorkingTreeBase(
  root: string,
): { base: string; paths: Set<string>; since: string } | { fallback: string } {
  const upstream = runGitText(root, ["rev-parse", "--verify", "-q", "@{upstream}"]).stdout.trim();
  const base = upstream ? runGitText(root, ["merge-base", upstream, "HEAD"]).stdout.trim() : "HEAD";
  const diff = diffNameOnly(root, [base]);
  const untracked = runGitText(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!base || diff.status !== 0 || untracked.status !== 0)
    return { fallback: "git could not list the changes" };
  const paths = new Set([...parseNulPaths(diff.stdout), ...parseNulPaths(untracked.stdout)]);
  return { base, paths, since: upstream ? upstream.slice(0, 9) : "HEAD" };
}

export function collectWorkingTreeChanges(root: string): ChangedFilesResult {
  const collected = collectWorkingTreeBase(root);
  if ("fallback" in collected) return collected;
  return {
    paths: collected.paths,
    shellShebangs: new Set(),
    sourcedPaths: new Set(),
    since: collected.since,
  };
}

export function collectWorkingTreeChangesWithShell(root: string): ChangedFilesResult {
  const collected = collectWorkingTreeBase(root);
  if ("fallback" in collected) return collected;
  if (!collected.paths.size)
    return {
      paths: collected.paths,
      shellShebangs: new Set(),
      sourcedPaths: new Set(),
      since: collected.since,
    };
  try {
    const { shellShebangs, sourcedPaths } = readWorkingTreeShellInputs(
      root,
      collected.base,
      collected.paths,
    );
    return { paths: collected.paths, shellShebangs, sourcedPaths, since: collected.since };
  } catch (error) {
    if (!(error instanceof GitCommandError || error instanceof ShellInputUnavailable)) throw error;
    return { fallback: "could not read shell inputs in the base commit or working tree" };
  }
}
