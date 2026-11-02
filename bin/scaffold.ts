#!/usr/bin/env bun
// scaffold <dir> [--name <package name>]
// Creates a repository from the skeleton of this scaffolding version: copies the template, fills
// in the name, the bun pin and this version as the scaffolding pin, and runs `git init`.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const dir = process.argv[2];
if (!dir || dir.startsWith("-")) {
  console.error("usage: scaffold <dir> [--name <package name>]");
  process.exit(2);
}
const target = resolve(dir);
if (existsSync(target) && readdirSync(target).length) {
  console.error(`[scaffold] ${target} is not empty`);
  process.exit(1);
}
const at = process.argv.indexOf("--name");
const name = at === -1 ? basename(target) : process.argv[at + 1];
const home = join(import.meta.dir, "..");
const own = JSON.parse(readFileSync(join(home, "package.json"), "utf8"));

cpSync(join(home, "template"), target, { recursive: true, verbatimSymlinks: true });
const values: Record<string, string> = {
  name,
  packageManager: own.packageManager,
  version: own.version,
};
for (const file of ["package.json", "README.md"]) {
  const path = join(target, file);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]),
  );
}
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: target, stdio: "inherit" });
console.log(`[scaffold] ${target} created. Next: cd ${dir} && bun install && bun run check`);
