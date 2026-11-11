import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The repository's submodule paths, from .gitmodules in `root`. Each submodule's own repository
 * checks its files, so the gate and the shared eslint and stylelint configs walk past them. */
export function submodulePaths(root = process.cwd()) {
  if (!existsSync(join(root, ".gitmodules"))) return [];
  const listed = spawnSync(
    "git",
    ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    { cwd: root, encoding: "utf8" },
  );
  return listed.status === 0
    ? listed.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(line.indexOf(" ") + 1))
    : [];
}
