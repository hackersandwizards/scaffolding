#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import {
  applyAllow,
  finish,
  listFiles,
  readPackage,
  reader,
  repoRoot,
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
const STYLES = /\.(?:css|scss|pcss)$/;
const HASHED = /\.(?:sh|py|ya?ml|toml)$|^\.githooks\//;
const TEST = /(?:^|\/)(?:__tests__|tests?|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIPPED = /(?:^|\/)(?:bun\.lock|package-lock\.json)$/;
const UP = /(?<![\w./-])(?:\.\.\/)+[^\s"'`)\],;]*/g;
const BRAND = "@hackersandwizards/brand";
const SHELL = "@hackersandwizards/scaffolding";
const CSS =
  /["'`(](?:[^"'`()\s]*?\/)??(node_modules\/)?(@hackersandwizards\/[\w.-]+)\/([^"'`()\s?#]+\.css)(?:[?#][^"'`()\s]*)?["'`)]/g;
const INSTALLED =
  /node_modules(?:\/|["'`]\s*[,/]\s*["'`])(@hackersandwizards(?:\/[\w.-]*)?)(\/[^\s"'`)\]},;$?#]*)?/g;
const COMMENT = /(^|[\s{])\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(?<![:"'`\\])\/\/.*/gm;
const HASH = /(^|\s)#.*/gm;
const DOCSTRING = /^(\s*)(?:"""[\s\S]*?"""|'''[\s\S]*?''')/gm;
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|@(?:import|use|forward|source|plugin|reference|config)\s+(?:url\()?\s*)["'`]([^"'`\n]+)["'`]/g;

function exported(exports: unknown, subpath: string): boolean {
  if (typeof exports === "string" || Array.isArray(exports)) return false;
  if (!exports || typeof exports !== "object") return true;
  const keys = Object.keys(exports).filter((k) => k.startsWith("."));
  if (keys.length === 0) return false;
  const want = `./${subpath}`;
  return keys.some((key) => {
    if ((exports as Record<string, unknown>)[key] === null) return false;
    if (key === want) return true;
    const star = key.indexOf("*");
    if (star === -1) return key.endsWith("/") && want.startsWith(key);
    const [head, tail] = [key.slice(0, star), key.slice(star + 1)];
    return (
      want.length > head.length + tail.length - 1 && want.startsWith(head) && want.endsWith(tail)
    );
  });
}

/** Whether a file of the package, named by its path on disk, is the target of an export. */
function targeted(exports: unknown, subpath: string): boolean {
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) return false;
  return Object.values(exports).some((target) => {
    if (typeof target !== "string") return false;
    const [head, tail] = posix.normalize(target).split("*");
    return tail === undefined
      ? head === subpath
      : subpath.length >= head.length + tail.length &&
          subpath.startsWith(head) &&
          subpath.endsWith(tail);
  });
}

const manifests = new Map<string, Record<string, unknown> | null>();
function manifest(name: string) {
  if (!manifests.has(name)) {
    const file = `${root}/node_modules/${name}/package.json`;
    manifests.set(name, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
  }
  return manifests.get(name);
}

const own = readPackage(root).name;
const withoutAllow = (json: string) => {
  let pkg;
  try {
    pkg = JSON.parse(json);
  } catch {
    return json;
  }
  if (pkg.scaffolding) pkg.scaffolding = { ...pkg.scaffolding, allow: undefined };
  return JSON.stringify(pkg, null, 2);
};
for (const path of listFiles(root, staged)) {
  if (!SCANNED.test(path) || SKIPPED.test(path)) continue;
  // An allow entry names the path it excuses; no rule reads it.
  const raw = read(path).toString("utf8");
  const text = path === "package.json" ? withoutAllow(raw) : raw;
  const base = path === "package.json" ? root : resolve(root, dirname(path));
  // A test holds path-like strings as data, so there only import specifiers count.
  const tokens = TEST.test(path)
    ? [...text.matchAll(SPECIFIER)].map((m) => m[1]).filter((spec) => spec.startsWith("../"))
    : [...text.matchAll(UP)].map((m) => m[0]);
  for (const token of tokens) {
    const target = resolve(base, token.replace(/[?#].*/, ""));
    if (target !== root && !target.startsWith(`${root}/`))
      flag(path, token, "path leaves the repository; take it from the package its owner publishes");
  }
  // Code, markup and data reach an installed company package through its exports or its bin, never
  // by a disk path; a stylesheet may name one, but only to a file an export maps (a stylesheet's .css
  // path is the CSS rule's). A comment, a docstring or a Tailwind @source names the path
  // without using it.
  const prose = path.endsWith(".py") ? text.replace(DOCSTRING, "$1") : text;
  if (text.includes("@hackersandwizards"))
    for (const line of prose.replace(HASHED.test(path) ? HASH : COMMENT, "$1").split("\n"))
      for (const m of line.matchAll(INSTALLED)) {
        if (m[1] === own || line.slice(0, m.index).includes("@source")) continue;
        if (STYLES.test(path)) {
          const pkg = manifest(m[1]);
          if (
            !m[2]?.endsWith(".css") &&
            !(pkg && !("exports" in pkg)) &&
            !(pkg && m[2] && targeted(pkg.exports, posix.normalize(m[2].slice(1))))
          )
            flag(path, m[0], `a stylesheet names a disk path only to a file ${m[1]} exports`);
        } else
          flag(
            path,
            m[0],
            "hard-coded path into an installed package: import.meta.resolve it through the package's exports (its ./package.json for the folder), run its command from node_modules/.bin, serve a catalog asset by its package path in the preset's copy, or name the exception in scaffolding.allow",
          );
      }
  if (!IMPORTING.test(path)) continue;
  if (!TEST.test(path))
    for (const [, disk, name, raw] of text.matchAll(CSS)) {
      const spec = `${name}/${raw}`;
      // Outside a stylesheet a disk path is the installed-path rule's.
      if (name === own || (disk !== undefined && !STYLES.test(path))) continue;
      const subpath = posix.normalize(raw);
      const pkg = manifest(name);
      const published =
        !pkg ||
        !("exports" in pkg) ||
        (disk === undefined ? exported(pkg.exports, subpath) : targeted(pkg.exports, subpath));
      const styles = (pkg?.scaffolding as { styles?: string[] } | undefined)?.styles ?? [];
      if (name === BRAND) {
        if (!published) flag(path, spec, `not in the exports of ${name}`);
      } else if (name === SHELL) {
        if (!path.startsWith("catalog/"))
          flag(path, spec, "the catalog shell's styles load only under catalog/");
      } else if (!styles.some((s) => posix.normalize(s) === subpath))
        flag(
          path,
          spec,
          "styles come from brand's exports, an engine's scaffolding.styles or this repository",
        );
      else if (!published) flag(path, spec, `not in the exports of ${name}`);
    }
  for (const [, raw] of text.matchAll(SPECIFIER)) {
    const spec = raw.replace(/\?.*/, "");
    if (/^(?:[./#~]|@\/|[a-z]+:)/.test(spec)) continue;
    const parts = spec.split("/");
    const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const subpath = posix.normalize(parts.slice(spec.startsWith("@") ? 2 : 1).join("/"));
    if (!subpath || subpath === ".") continue;
    const pkg = manifest(name);
    if (pkg && "exports" in pkg && !exported(pkg.exports, subpath))
      flag(path, spec, `not in the exports of ${name}`);
  }
}

const GIT =
  /^(?:github:|gitlab:|bitbucket:|git\+|git:|git@|https?:\/\/\S+\.git(?:#|$))|^[\w.-]+\/[\w.-]+(?:#|$)/;
const TAG = /#(?:semver:)?v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
if (!staged || listFiles(root, true).includes("package.json")) {
  const pkg = staged ? JSON.parse(read("package.json").toString("utf8")) : readPackage(root);
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ])
    for (const [name, spec] of Object.entries((pkg[field] ?? {}) as Record<string, string>)) {
      if (/^(?:file|link|portal):/.test(spec))
        flag("package.json", `${name}@${spec}`, "local path dependency");
      else if (GIT.test(spec) && !TAG.test(spec))
        flag("package.json", `${name}@${spec}`, "Git dependency not pinned to a version tag");
      // A stale install renders with the old engine while every file reads the new pin: documents
      // once ran brand 0.21.6 against a v0.24.4 pin, and its list markers vanished.
      else if (GIT.test(spec) && field !== "peerDependencies") {
        const pinned = TAG.exec(spec)![0].replace(/^#(?:semver:)?v?/, "");
        const installed = (manifest(name)?.version as string | undefined) ?? "nothing";
        if (installed !== pinned)
          flag(
            "package.json",
            `${name}@${spec}`,
            `node_modules holds ${installed}, not the pinned ${pinned}: bun install`,
          );
      }
    }
}

finish("check-coupling", applyAllow(root, "coupling", findings, !staged), started);
