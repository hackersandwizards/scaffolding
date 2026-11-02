#!/usr/bin/env bun
// scaffold <dir> [--name <package name>]
// Creates a repository from the skeleton of this scaffolding version: copies the template, makes
// the skeleton's symlinks, fills in the name, the bun pin and this version as the scaffolding pin,
// and runs `git init`.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

cpSync(join(home, "template"), target, { recursive: true });
// Stored under another name: as eslint.config.js it would lint this package's own template files
// with an import of this package that only resolves in a repository that installs it.
renameSync(join(target, "eslint.config.js.tmpl"), join(target, "eslint.config.js"));
// A Git dependency installs without symlinks, so the skeleton's links are made here.
const { symlinks } = JSON.parse(readFileSync(join(home, "skeleton.json"), "utf8"));
for (const [path, link] of Object.entries<string>(symlinks)) {
  mkdirSync(dirname(join(target, path)), { recursive: true });
  symlinkSync(link, join(target, path));
}
const values: Record<string, string> = {
  name,
  packageManager: own.packageManager,
};
for (const file of ["package.json", "README.md"]) {
  const path = join(target, file);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]),
  );
}
// The toolchain at the versions this scaffolding release checks itself with.
const pkgPath = join(target, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
// The eslint plugins come with this package, so only the tools themselves are pinned here.
const tools = ["@types/bun", "eslint", "prettier", "typescript"];
// Set here, not in the template: there it would govern this package's own template files with a
// package that only resolves in a repository that installs it.
pkg.prettier = "@hackersandwizards/scaffolding/prettier";
pkg.devDependencies = {
  ...Object.fromEntries(tools.map((t) => [t, own.devDependencies[t]])),
  "@hackersandwizards/scaffolding": `github:hackersandwizards/scaffolding#v${own.version}`,
};
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: target, stdio: "inherit" });
console.log(`[scaffold] ${target} created. Next: cd ${dir} && bun install && bun run check`);
