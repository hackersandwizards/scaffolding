import { lstatSync } from "node:fs";
import { join } from "node:path";
import { git } from "./repo.ts";

export const inNodeModules = (path: string) => path.split("/").includes("node_modules");

export function trackedInputs(root: string, ...pathspecs: string[]): string[] {
  return git(["ls-files", "--stage", "-z", "--", ...pathspecs], root)
    .toString()
    .split("\0")
    .filter((entry) => /^100[67][0-7]{2} [0-9a-f]+ 0\t/.test(entry))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1))
    .filter((path) => !inNodeModules(path) && regularInput(root, path));
}

export function regularInput(root: string, path: string): boolean {
  const parts = path.split("/");
  const leaf = parts.pop()!;
  let directory = root;
  for (const part of parts) {
    directory = join(directory, part);
    if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return false;
  }
  return lstatSync(join(directory, leaf), { throwIfNoEntry: false })?.isFile() === true;
}
