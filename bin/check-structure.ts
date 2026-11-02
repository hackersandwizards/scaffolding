#!/usr/bin/env bun
// check-structure [--fix]
// The repository against the skeleton of the pinned scaffolding version: identical files, files
// that must or must not exist, the `.agents/skills` link, the prettier rules, package.json fields
// and the hooks path. `--fix` writes what can be written from the template: identical files, the
// link and the hooks path.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { applyAllow, finish, readPackage, repoRoot, type Finding } from "../lib/repo.ts";

const started = performance.now();
const fix = process.argv.includes("--fix");
const root = repoRoot();
const home = join(import.meta.dir, "..");
const skeleton = JSON.parse(readFileSync(join(home, "skeleton.json"), "utf8"));
const own = JSON.parse(readFileSync(join(home, "package.json"), "utf8"));
const findings: Finding[] = [];
const add = (path: string, message: string, text = "") =>
  findings.push({ check: "structure", path, text, message });
const at = (path: string) => join(root, path);
const exists = (path: string) => {
  try {
    lstatSync(at(path));
    return true;
  } catch {
    return false;
  }
};

for (const path of skeleton.same as string[]) {
  const template = join(home, "template", path);
  if (exists(path) && readFileSync(at(path)).equals(readFileSync(template))) continue;
  if (fix) {
    mkdirSync(dirname(at(path)), { recursive: true });
    copyFileSync(template, at(path));
  } else
    add(
      path,
      exists(path)
        ? "differs from the skeleton (check-structure --fix)"
        : "missing (check-structure --fix)",
    );
}
for (const path of skeleton.present as string[]) if (!exists(path)) add(path, "missing");
for (const path of skeleton.absent as string[])
  if (exists(path)) add(path, "not allowed by the skeleton");

for (const [path, target] of Object.entries<string>(skeleton.symlinks)) {
  if (exists(path) && lstatSync(at(path)).isSymbolicLink() && readlinkSync(at(path)) === target)
    continue;
  if (fix && !exists(path)) {
    mkdirSync(dirname(at(path)), { recursive: true });
    symlinkSync(target, at(path));
  } else add(path, `must be a symlink to ${target}`);
}

// Prettier's own resolution, so the rules count from any config form, the shared one included.
// The repository's prettier first, else this package's; without either the check fails closed.
const prettierEntry = join(root, "node_modules/prettier/index.mjs");
const prettier = await import(existsSync(prettierEntry) ? prettierEntry : "prettier").catch(
  () => undefined,
);
if (!prettier) add("prettier config", "prettier not installed: bun install");
else {
  const rc = (await prettier.resolveConfig(at("package.json"))) ?? {};
  for (const [key, value] of Object.entries(skeleton.prettier))
    if (rc[key] !== value)
      add(
        "prettier config",
        `${key} must be ${JSON.stringify(value)}`,
        `${key}: ${JSON.stringify(rc[key])}`,
      );
}

if (existsSync(at("package.json"))) {
  const pkg = readPackage(root);
  if (pkg.type !== skeleton.package.type)
    add("package.json", `type must be ${skeleton.package.type}`);
  if (pkg.engines?.npm !== skeleton.package["engines.npm"])
    add("package.json", `engines.npm must be ${skeleton.package["engines.npm"]}`);
  if (pkg.packageManager !== own.packageManager)
    add("package.json", `packageManager must be ${own.packageManager}`, String(pkg.packageManager));
  for (const script of skeleton.package.scripts as string[])
    if (!pkg.scripts?.[script]) add("package.json", `script ${script} missing`, script);
}

const hooks = spawnSync("git", ["config", "core.hooksPath"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
if (hooks !== skeleton.hooksPath) {
  if (fix) spawnSync("git", ["config", "core.hooksPath", skeleton.hooksPath], { cwd: root });
  else
    add(
      ".git/config",
      `core.hooksPath must be ${skeleton.hooksPath} (bun install runs prepare)`,
      hooks,
    );
}

finish("check-structure", applyAllow(root, "structure", findings, true), started);
