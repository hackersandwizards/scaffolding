import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

// @puppeteer/browsers downloads <build id>-<file> beside the build's folder, unpacks it there and
// deletes it after, so the folder holds the executable long before it is whole. An archive written
// within UNPACK_WAIT_MS is an unpack under way; an older one is an install that died or hangs: one
// hung 15 minutes while gates took its half-unpacked build.
export const UNPACK_WAIT_MS = 120_000;
export const writtenAgo = (path: string) => {
  const entry = statSync(path, { throwIfNoEntry: false });
  return entry ? Date.now() - entry.mtimeMs : 0;
};
const archivesOf = (build: string, names: string[]) =>
  names.filter((name) => name.startsWith(`${build.slice(build.indexOf("-") + 1)}-`));
export function stateOf(folder: string, build: string, names = readdirSync(folder)) {
  const archives = archivesOf(build, names);
  if (archives.length === 0) return "whole";
  return archives.some((name) => writtenAgo(join(folder, name)) < UNPACK_WAIT_MS)
    ? "unpacking"
    : "died";
}

export function pruneChromeBuildArchives(folder: string, build: string) {
  for (const name of archivesOf(build, readdirSync(folder)))
    if (writtenAgo(join(folder, name)) >= UNPACK_WAIT_MS)
      rmSync(join(folder, name), { force: true });
}

export function retireChromeBuild(cachedBuild: string, staged: string) {
  try {
    renameSync(cachedBuild, join(staged, "died"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function moveChromeBuild(stagedBuild: string, cachedBuild: string, executable: string) {
  try {
    renameSync(stagedBuild, cachedBuild);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    // A competing unpack can start after the first look at the destination.
    if (stateOf(dirname(cachedBuild), basename(cachedBuild)) === "unpacking") return false;
    if (!existsSync(executable)) throw error;
  }
  return true;
}

export function installedChromeRelativePath(staged: string, output: string) {
  const installed = output.trim();
  const rel = relative(staged, installed);
  if (!installed || rel.startsWith("..")) return undefined;
  return rel;
}
