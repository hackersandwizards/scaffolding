import { oxlintSource } from "./oxlint.ts";
import { git } from "./repo.ts";

export const stagedDiff = (root: string) =>
  git(["diff", "--cached", "--raw", "--diff-filter=ACMRT", "-z"], root).toString();

export function stagedPaths(raw: string) {
  const staged: string[] = [];
  const oxlintPaths: string[] = [];
  const regularPaths: string[] = [];
  const fields = raw.split("\0");
  for (let i = 0; i + 1 < fields.length;) {
    const [, mode, , , status] = fields[i].split(" ");
    const paths = /^[RC]/.test(status) ? 2 : 1;
    const file = fields[i + paths];
    const regular = mode?.startsWith("100");
    // A type change can introduce a regular file in place of a symlink or submodule.
    if (mode !== "160000" && (status !== "T" || regular)) staged.push(file);
    if (regular) {
      regularPaths.push(file);
      if (oxlintSource.test(file)) oxlintPaths.push(file);
    }
    i += paths + 1;
  }
  return { staged, oxlintPaths, regularPaths };
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
