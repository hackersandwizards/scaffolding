import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git as readGit } from "./repo.ts";
import { gitShellScripts, needsShellShebang, shellInput, shellSources } from "./shell-inputs.ts";
import { inNodeModules, regularInput, trackedInputs, treeInputs } from "./tracked-inputs.ts";

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

export function collectRangeChanges(
  root: string,
  ranges: readonly string[],
  checkShell: boolean,
): ChangedFilesResult {
  const paths = new Set<string>();
  const shellShebangs = new Set<string>();
  const sourcedPaths = new Set<string>();
  const checkedTrees = new Set<string>();
  const recordTree = (ref: string) => {
    if (checkedTrees.has(ref)) return;
    const { shebangs, sourced } = readShellTreeInputs(root, ref);
    for (const path of shebangs) shellShebangs.add(path);
    for (const path of sourced) sourcedPaths.add(path);
    checkedTrees.add(ref);
  };
  for (const range of ranges) {
    const resolved = verifyCommitRange(root, range);
    if ("fallback" in resolved) return resolved;
    const diff = diffNameOnly(root, [resolved.base, resolved.head]);
    if (diff.status !== 0) return { fallback: "git could not list the changes" };
    const touched = parseNulPaths(diff.stdout);
    for (const path of touched) paths.add(path);
    if (checkShell && touched.length) {
      try {
        recordTree(resolved.base);
        recordTree(resolved.head);
      } catch {
        return { fallback: "git could not read shell inputs in the pushed ranges" };
      }
    }
  }
  const since = ranges.map((r) => r.split("..")[0].slice(0, 9)).join(", ");
  return { paths, shellShebangs, sourcedPaths, since };
}

export function readWorkingTreeShellInputs(
  root: string,
  base: string,
  changedPaths: ReadonlySet<string>,
): { shellShebangs: Set<string>; sourcedPaths: Set<string> } {
  const baseShell = readShellTreeInputs(root, base);
  const shellShebangs = new Set<string>(baseShell.shebangs);
  const sourcedPaths = new Set<string>(baseShell.sourced);
  const tracked = trackedInputs(root);
  const scripts = tracked.filter((path) => shellInput(path, join(root, path)));
  for (const path of shellSources(scripts, tracked, (path) => readFileSync(join(root, path))))
    sourcedPaths.add(path);
  for (const path of changedPaths) {
    if (inNodeModules(path) || !needsShellShebang(path)) continue;
    if (regularInput(root, path) && shellInput(path, join(root, path))) shellShebangs.add(path);
  }
  return { shellShebangs, sourcedPaths };
}

export function collectWorkingTreeChanges(root: string, checkShell: boolean): ChangedFilesResult {
  const upstream = runGitText(root, ["rev-parse", "--verify", "-q", "@{upstream}"]).stdout.trim();
  const base = upstream ? runGitText(root, ["merge-base", upstream, "HEAD"]).stdout.trim() : "HEAD";
  const diff = diffNameOnly(root, [base]);
  const untracked = runGitText(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!base || diff.status !== 0 || untracked.status !== 0)
    return { fallback: "git could not list the changes" };
  const paths = new Set([...parseNulPaths(diff.stdout), ...parseNulPaths(untracked.stdout)]);
  const since = upstream ? upstream.slice(0, 9) : "HEAD";
  if (!checkShell || !paths.size)
    return { paths, shellShebangs: new Set(), sourcedPaths: new Set(), since };
  try {
    const { shellShebangs, sourcedPaths } = readWorkingTreeShellInputs(root, base, paths);
    return { paths, shellShebangs, sourcedPaths, since };
  } catch {
    return { fallback: "could not read shell inputs in the base commit or working tree" };
  }
}
