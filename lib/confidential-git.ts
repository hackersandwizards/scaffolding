import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./repo.ts";

export type SnapshotEntry = { type: string; sha: string; path: string };
export type PurgedHashList = { bad: ReadonlySet<string>; hash: (sha: string) => string };

// Git writes the original source expression, which can contain spaces.
export function parsePrepushRefs(input: string): { locals: string[]; remoteTips: string[] } {
  const lines = input.split("\n").map((line) => line.split(" "));
  const extract = (index: number) =>
    lines.map((line) => line.at(index)).filter((sha): sha is string => !!sha && !/^0+$/.test(sha));
  return { locals: extract(-3), remoteTips: extract(-1) };
}

// "<added>\t<deleted>\t<path>", "-" for a file git diffs as binary, in the patch's order.
export function parseNumstatEntries(output: string): { binary: boolean; path: string }[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((line) => ({
      binary: line.startsWith("-\t-\t"),
      path: line.replace(/^\S+\t\S+\t/, ""),
    }));
}

export function parseCatFileBatch(batch: Buffer, paths: readonly string[]): Buffer[] {
  let at = 0;
  return paths.map((path) => {
    const header = batch.indexOf(10, at);
    const [, type, length] = batch.subarray(at, header).toString().split(" ");
    if (type !== "blob")
      throw new Error(
        `git cat-file: ${path} not readable (${type}), so the scan cannot inspect its contents. Run \`git fsck\` and repair the reported Git objects before rescanning.`,
      );
    const data = batch.subarray(header + 1, header + 1 + Number(length));
    at = header + 2 + Number(length);
    return data;
  });
}

export function parseTreeEntries(output: string): SnapshotEntry[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^\d+ (\w+) (\w+)\t(.*)$/s.exec(line);
      if (!match) throw new Error(`unexpected git ls-tree line: ${line}`);
      const [, type, sha, path] = match;
      return { type, sha, path };
    });
}

export function parseIndexEntries(output: string): {
  entries: SnapshotEntry[];
  unmergedPath?: string;
} {
  const entries: SnapshotEntry[] = [];
  for (const line of output.split("\0").filter(Boolean)) {
    // "<mode> <sha> <stage>\t<path>"; mode 160000 is a submodule's commit.
    const match = /^(\d+) (\w+) (\d)\t(.*)$/s.exec(line);
    if (!match) throw new Error(`unexpected git ls-files line: ${line}`);
    const [, mode, sha, stage, path] = match;
    if (stage !== "0") return { entries, unmergedPath: path };
    entries.push({ type: mode === "160000" ? "commit" : "blob", sha, path });
  }
  return { entries };
}

// git-lfs also refuses a change to a file someone else locked, LFS-tracked or not.
export function hasLfsOrLockableAttr(checkAttrOutput: string): boolean {
  const out = checkAttrOutput.split("\0");
  return out.some(
    (value, index) =>
      index % 3 === 2 && ["filter=lfs", "lockable=set"].includes(`${out[index - 1]}=${value}`),
  );
}

// An empty objects folder holds nothing to upload.
export function directoryHoldsFile(dir: string): boolean {
  return (
    existsSync(dir) &&
    readdirSync(dir, { withFileTypes: true }).some(
      (entry) =>
        entry.isFile() ||
        entry.isSymbolicLink() ||
        (entry.isDirectory() && directoryHoldsFile(join(dir, entry.name))),
    )
  );
}

export function findPurgedCommitFindings(
  commits: readonly string[],
  lists: readonly PurgedHashList[],
): Finding[] {
  const findings: Finding[] = [];
  for (const commit of commits) {
    if (lists.some(({ bad, hash }) => bad.has(hash(commit)))) {
      findings.push({
        check: "confidential",
        path: "push",
        text: commit,
        message:
          "commit purged from this repository's history: clone again and carry your own work over by hand",
      });
    }
  }
  return findings;
}
