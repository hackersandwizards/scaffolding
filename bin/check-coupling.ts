#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import {
  applyAllow,
  commentSyntax,
  exportTargets,
  finish,
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
const STYLES = /\.(?:css|scss|pcss)$/;
const SKIPPED = /(?:^|\/)(?:bun\.lock|package-lock\.json)$/;
// A climb, bare or after "./", a variable or a command: one naming the root ($ROOT, ${root},
// $(git rev-parse --show-toplevel)) climbs from the root, any other from the file's folder.
const UP = /(?<![\w./-])(?:(\$\{[^}\s]*\}|\$\([^)]*\)|\$\w+|\.)\/)?(?:\.\.\/)+[^\s"'`)\],;]*/g;
// A path from a home folder: ~, $HOME, ${process.env.HOME}, ${homedir()}, /Users/<name>.
const HOME =
  /(?<![\w./$~-])(?:~|\$\{?HOME\}?|\$\{(?:process\.env\.HOME|(?:os\.)?homedir\(\))\}|\/(?:Users|home)\/[\w.-]+)(\/[^\s"'`)\],;$]*)/g;
const BRAND = "@hackersandwizards/brand";
const SHELL = "@hackersandwizards/scaffolding";
const CSS =
  /["'`(](?:[^"'`()\s]*?\/)??(node_modules\/)?(@hackersandwizards\/[\w.-]+)\/([^"'`()\s?#]+\.css)(?:[?#][^"'`()\s]*)?["'`)]/g;
const INSTALLED =
  /node_modules[\s"'`,/\\)+]{1,8}(@hackersandwizards(?:\/[\w.-]*)?)(\/[^\s"'`)\]},;$?#]*)?/g;
// A docstring opens the file or the block a line ending in ":" starts.
const DOCSTRING = /(^\s*|:[ \t]*\n\s*)(?:"""[\s\S]*?"""|'''[\s\S]*?''')/g;
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|@(?:import|use|forward|source|plugin|reference|config)\s+(?:url\()?\s*)["'`]([^"'`\n]+)["'`]/g;

/** Whether an exports key or target, with one `*` at most that crosses folders, matches a path. */
function matches(pattern: string, path: string): boolean {
  const [head, tail] = pattern.split("*");
  return tail === undefined
    ? head === path
    : path.length >= head.length + tail.length && path.startsWith(head) && path.endsWith(tail);
}

function exported(exports: unknown, subpath: string): boolean {
  if (typeof exports === "string" || Array.isArray(exports)) return false;
  if (!exports || typeof exports !== "object") return true;
  const keys = Object.keys(exports).filter((k) => k.startsWith("."));
  if (keys.length === 0) return false;
  const want = `./${subpath}`;
  return keys.some((key) => {
    if ((exports as Record<string, unknown>)[key] === null) return false;
    return matches(key, want) || (!key.includes("*") && key.endsWith("/") && want.startsWith(key));
  });
}

/** Whether a file of the package, named by its path on disk, is the target of an export. */
function targeted(exports: unknown, subpath: string): boolean {
  return exportTargets(exports).some((target) => matches(posix.normalize(target), subpath));
}

const manifests = new Map<string, Record<string, unknown> | null>();
function manifest(name: string) {
  if (!manifests.has(name)) {
    const file = `${root}/node_modules/${name}/package.json`;
    manifests.set(name, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
  }
  return manifests.get(name);
}

/** Whether a company package publishes a file, named by an export or, on disk, as an export's
 * target; a package not installed or without exports is not judged. */
function publishes(name: string, subpath: string, disk: boolean): boolean {
  const pkg = manifest(name);
  return !pkg || !("exports" in pkg) || (disk ? targeted : exported)(pkg.exports, subpath);
}

// Git reports the root by its real path (/private/tmp on macOS).
const home = existsSync(homedir()) ? realpathSync(homedir()) : homedir();
// The home folder's child holding this checkout (~/dev): a path under it outside this checkout
// reaches another checkout, cloned here or not, works on this machine only, and breaks when that
// repository moves.
const devRoot = root.startsWith(`${home}/`) ? join(home, relative(home, root).split("/")[0]) : "";

const own = readPackage(root).name;
// The pins and the allow list as the commit holds them in a staged run.
const pkg = readPackage(root, staged ? ":" : undefined);
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
const leaves = "path leaves the repository; take it from the package its owner publishes";
const outside = (target: string) => target !== root && !target.startsWith(`${root}/`);
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
    if (outside(target)) flag(path, token, leaves);
  }
  if (!test)
    for (const [token, rest] of text.matchAll(HOME)) {
      const target = resolve(home + rest);
      if (devRoot && target.startsWith(`${devRoot}/`) && outside(target)) flag(path, token, leaves);
    }
  // Code, markup and data reach an installed company package through its exports or its bin, never
  // by a disk path; a stylesheet may name one, but only to a file an export maps (a stylesheet's .css
  // path is the CSS rule's). A comment, a docstring or a Tailwind @source names the path
  // without using it.
  if (text.includes("@hackersandwizards"))
    for (const line of (path.endsWith(".py") ? text.replace(DOCSTRING, "$1") : text)
      .replace(commentSyntax(path), (comment, kept = "", at: number, all: string) => {
        // A line mark after an unclosed quote (`x//y`) sits in a string: code follows.
        let open = "";
        for (const c of all.slice(all.lastIndexOf("\n", at) + 1, at) + kept)
          if (open ? c === open : "\"'`".includes(c)) open = open ? "" : c;
        return open && !comment.startsWith("/*", kept.length) ? comment : kept;
      })
      .split("\n"))
      for (const m of line.matchAll(INSTALLED)) {
        if (m[1] === own || line.slice(0, m.index).includes("@source")) continue;
        if (STYLES.test(path)) {
          const file = m[2]?.slice(1) && posix.normalize(m[2].slice(1));
          if (!file || (!file.endsWith(".css") && !publishes(m[1], file, true)))
            flag(path, m[0], `a stylesheet names a disk path only to a file ${m[1]} exports`);
        } else
          flag(
            path,
            m[0],
            "hard-coded path into an installed package: import.meta.resolve it through the package's exports (its ./package.json for the folder), run its command from node_modules/.bin, serve a catalog asset by its package path in the preset's copy, or name the exception in scaffolding.allow",
          );
      }
  if (!IMPORTING.test(path)) continue;
  if (!test)
    for (const [, disk, name, raw] of text.matchAll(CSS)) {
      const spec = `${name}/${raw}`;
      // Outside a stylesheet a disk path is the installed-path rule's, which leaves a stylesheet's
      // .css paths, a Tailwind @source included, to this rule.
      if (name === own || (disk !== undefined && !STYLES.test(path))) continue;
      const subpath = posix.normalize(raw);
      const pkg = manifest(name);
      const published = publishes(name, subpath, disk !== undefined);
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
      // A stale install renders with the old engine while every file reads the new pin.
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

finish("check-coupling", applyAllow(pkg, "coupling", findings, !staged), started);
