#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import {
  cssImportHits,
  dependencyPinHits,
  installedPathHits,
  PackageRegistry,
} from "../lib/coupling-checks.ts";
import { exported } from "../lib/package-exports.ts";
import {
  applyAllow,
  finish,
  git,
  isObject,
  jsonObject,
  listFiles,
  readPackage,
  reader,
  repoRoot,
  TEST,
  type Finding,
} from "../lib/repo.ts";

const started = performance.now();
const staged = process.argv.includes("--staged");
const root = repoRoot();
const read = reader(root, staged);
const findings: Finding[] = [];
const seen = new Set<string>();
const flag = (path: string, text: string, message: string) => {
  const key = `${path}\0${text}\0${message}`;
  if (!seen.has(key)) findings.push({ check: "coupling", path, text, message });
  seen.add(key);
};

const SCANNED =
  /\.(?:[cm]?[jt]sx?|astro|vue|svelte|css|scss|pcss|html|sh|py|json|jsonc|toml|ya?ml)$|^\.githooks\//;
const IMPORTING = /\.(?:[cm]?[jt]sx?|astro|vue|svelte|css|scss|pcss|html)$/;
const SKIPPED = /(?:^|\/)(?:bun\.lock|package-lock\.json)$/;
// A climb, bare or after "./", a variable or a command: one naming the root ($ROOT, ${root},
// $(git rev-parse --show-toplevel)) climbs from the root, any other from the file's folder.
const UP = /(?<![\w./-])(?:(\$\{[^}\s]*\}|\$\([^)]*\)|\$\w+|\.)\/)?(?:\.\.\/)+[^\s"'`)\],;]*/g;
// A path from a home folder: ~, $HOME, ${process.env.HOME}, ${homedir()}, /Users/<name>.
const HOME =
  /(?<![\w./$~-])(?:~|\$\{?HOME\}?|\$\{(?:process\.env\.HOME|(?:os\.)?homedir\(\))\}|\/(?:Users|home)\/[\w.-]+)(\/[^\s"'`)\],;$]*)/g;
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|@(?:import|use|forward|source|plugin|reference|config)\s+(?:url\()?\s*)["'`]([^"'`\n]+)["'`]/g;

// Git reports the root by its real path (/private/tmp on macOS).
const home = existsSync(homedir()) ? realpathSync(homedir()) : homedir();
// The repository's main checkout, also for a linked worktree, which may sit outside the dev root.
const common = realpathSync(
  git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root).toString().trim(),
);
const main = basename(common) === ".git" ? dirname(common) : root;
// The home folder's child holding the main checkout (~/dev): a path under it outside this
// repository reaches another checkout, cloned here or not, works on this machine only, and breaks
// when that repository moves.
const devRoot = main.startsWith(`${home}/`) ? join(home, relative(home, main).split("/")[0]) : "";

const own = readPackage(root).name;
// The pins and the allow list as the commit holds them in a staged run.
const pkg = readPackage(root, staged ? ":" : undefined);
const registry = new PackageRegistry(root, pkg, own);
const withoutAllow = (json: string) => {
  let parsed;
  try {
    parsed = jsonObject(json);
  } catch {
    return json;
  }
  if (isObject(parsed.scaffolding))
    parsed.scaffolding = { ...parsed.scaffolding, allow: undefined };
  return JSON.stringify(parsed, null, 2);
};
const leaves = "path leaves the repository; take it from the package its owner publishes";
const isOutsideCheckout = (target: string, base = root) =>
  target !== base && !target.startsWith(`${base}/`);

for (const path of listFiles(root, staged)) {
  if (!SCANNED.test(path) || SKIPPED.test(path)) continue;
  // An allow entry names the path it excuses; no rule reads it.
  const raw = read(path).toString("utf8");
  const text = path === "package.json" ? withoutAllow(raw) : raw;
  const base = path === "package.json" ? root : resolve(root, dirname(path));
  // A test holds path-like strings as data, so there only import specifiers count.
  const test = TEST.test(path);
  const tokens = test
    ? [...text.matchAll(SPECIFIER)]
        .map((m) => ({ token: m[1], from: base, climb: m[1] }))
        .filter((t) => t.token.startsWith("../"))
    : [...text.matchAll(UP)].map(([token, prefix]) => ({
        token,
        from: prefix && /root|toplevel/i.test(prefix) ? root : base,
        climb: prefix ? token.slice(prefix.length + 1) : token,
      }));
  for (const { token, from, climb } of tokens) {
    const target = resolve(from, climb.replace(/[?#].*/, ""));
    if (isOutsideCheckout(target)) flag(path, token, leaves);
  }
  if (!test)
    for (const [token, rest] of text.matchAll(HOME)) {
      const target = resolve(home + rest);
      if (
        devRoot &&
        target.startsWith(`${devRoot}/`) &&
        isOutsideCheckout(target) &&
        isOutsideCheckout(target, main)
      )
        flag(path, token, leaves);
    }
  for (const hit of installedPathHits(path, text, registry)) flag(path, hit.text, hit.message);
  if (!IMPORTING.test(path)) continue;
  if (!test)
    for (const hit of cssImportHits(path, text, registry)) flag(path, hit.text, hit.message);
  for (const [, rawSpec] of text.matchAll(SPECIFIER)) {
    const spec = rawSpec.replace(/\?.*/, "");
    if (/^(?:[./#~]|@\/|[a-z]+:)/.test(spec)) continue;
    const parts = spec.split("/");
    const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const subpath = posix.normalize(parts.slice(spec.startsWith("@") ? 2 : 1).join("/"));
    if (!subpath || subpath === ".") continue;
    const targetPkg = registry.manifest(name);
    if (targetPkg && "exports" in targetPkg && !exported(targetPkg.exports, subpath))
      flag(
        path,
        spec,
        `not in the exports of ${name}: import a subpath listed in ${name}'s package.json exports, or add this subpath to ${name}'s exports and release a new tag; do not silence with scaffolding.allow`,
      );
  }
}

if (!staged || listFiles(root, true).includes("package.json")) {
  for (const hit of dependencyPinHits(pkg, registry)) flag("package.json", hit.text, hit.message);
}

finish("check-coupling", applyAllow(pkg, "coupling", findings, !staged), started);
