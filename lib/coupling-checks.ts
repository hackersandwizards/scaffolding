import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import oxlintTemplate from "../template/.oxlintrc.json";
import { exported, targeted } from "./package-exports.ts";
import { commentSyntax, jsonObject, ourRepository } from "./repo.ts";

export type CouplingHit = { text: string; message: string };
export type CssImportMatch = { name: string; raw: string; disk: boolean };

export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const STYLES = /\.(?:css|scss|pcss)$/;
const BRAND = "@hackersandwizards/brand";
const SHELL = "@hackersandwizards/scaffolding";
const CSS =
  /["'`(](?:[^"'`()\s]*?\/)??(node_modules\/)?(@hackersandwizards\/[\w.-]+)\/([^"'`()\s?#]+\.css)(?:[?#][^"'`()\s]*)?["'`)]/g;
const INSTALLED =
  /node_modules[\s"'`,/\\)+]{1,8}(@[\w.-]+(?:\/[\w.-]*)?|[\w.-]+)(\/[^\s"'`)\]},;$?#]*)?/g;
// A docstring opens the file or the block a line ending in ":" starts.
const DOCSTRING = /(^\s*|:[ \t]*\n\s*)(?:"""[\s\S]*?"""|'''[\s\S]*?''')/g;
const GIT =
  /^(?:github:|gitlab:|bitbucket:|git\+|git:|git@|https?:\/\/\S+\.git(?:#|$))|^[\w.-]+\/[\w.-]+(?:#|$)/;
const TAG = /#(?:semver:)?v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

export class PackageRegistry {
  private readonly manifests = new Map<string, Record<string, unknown> | null>();
  private readonly pinnedOurs: Set<string>;
  readonly root: string;
  readonly own: string | undefined;

  constructor(root: string, pkg: Record<string, unknown>, own?: string) {
    this.root = root;
    this.own = own;
    // Ours: our scope, or a Git pin on a repository we own, whatever the package's name.
    this.pinnedOurs = new Set(
      DEPENDENCY_FIELDS.flatMap((field) =>
        Object.entries((pkg[field] ?? {}) as Record<string, string>)
          .filter(([, spec]) => ourRepository(spec))
          .map(([name]) => name),
      ),
    );
  }

  manifest(name: string): Record<string, unknown> | null | undefined {
    if (!this.manifests.has(name)) {
      const file = `${this.root}/node_modules/${name}/package.json`;
      this.manifests.set(name, existsSync(file) ? jsonObject(readFileSync(file)) : null);
    }
    return this.manifests.get(name);
  }

  isOurs(name: string): boolean {
    return name.startsWith("@hackersandwizards") || this.pinnedOurs.has(name);
  }

  /** Whether a company package publishes a file, named by an export or, on disk, as an export's
   * target; a package not installed or without exports is not judged. */
  publishes(name: string, subpath: string, disk: boolean): boolean {
    const pkg = this.manifest(name);
    return !pkg || !("exports" in pkg) || (disk ? targeted : exported)(pkg.exports, subpath);
  }
}

export function isInsideOpenQuote(text: string, at: number, kept: string): boolean {
  // A line mark after an unclosed quote (`x//y`) sits in a string: code follows.
  let open = "";
  for (const ch of text.slice(text.lastIndexOf("\n", at) + 1, at) + kept)
    if (open ? ch === open : "\"'`".includes(ch)) open = open ? "" : ch;
  return Boolean(open);
}

export function stripUnquotedComments(text: string, syntax: RegExp): string {
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(syntax)) {
    const at = match.index;
    const comment = match[0];
    const kept = match[1] ?? "";
    const keepWhole = isInsideOpenQuote(text, at, kept) && !comment.startsWith("/*", kept.length);
    out += text.slice(cursor, at) + (keepWhole ? comment : kept);
    cursor = at + comment.length;
  }
  return out + text.slice(cursor);
}

export function stripCouplingComments(path: string, text: string): string {
  const withoutDocstrings = path.endsWith(".py") ? text.replace(DOCSTRING, "$1") : text;
  return stripUnquotedComments(withoutDocstrings, commentSyntax(path));
}

export function isAllowedOxlintExtends(path: string, line: string): boolean {
  // Oxlint's JSON extends accepts a relative file path, including when it names our export.
  return (
    path === ".oxlintrc.json" &&
    line.trim() === `"extends": ${JSON.stringify(oxlintTemplate.extends)},`
  );
}

export function installedPackageViolation(
  path: string,
  match: RegExpExecArray,
  registry: PackageRegistry,
): string | undefined {
  if (!STYLES.test(path))
    return "hard-coded path into an installed package: resolve it through the package's exports with import.meta.resolve (use ./package.json for the package folder), run its command from node_modules/.bin, or serve a catalog asset by its package path in the catalog preset's copy. Only if no export or bin fits, record the exception with a concrete reason in package.json scaffolding.allow";
  const pkgName = match[1]!;
  const file = match[2]?.slice(1) && posix.normalize(match[2].slice(1));
  if (!file || (!file.endsWith(".css") && !registry.publishes(pkgName, file, true)))
    return `a stylesheet names a disk path only to a file ${pkgName} exports: import an exported path of ${pkgName} instead, or export the file in ${pkgName}'s package.json exports and release a new tag; do not silence with scaffolding.allow`;
  return undefined;
}

export function installedPathHits(
  path: string,
  text: string,
  registry: PackageRegistry,
): CouplingHit[] {
  // Code, markup and data reach an installed company package through its exports or its bin, never
  // by a disk path; a stylesheet may name one, but only to a file an export maps (a stylesheet's .css
  // path is the CSS rule's). A comment, a docstring or a Tailwind @source names the path
  // without using it.
  if (!text.includes("node_modules")) return [];
  const hits: CouplingHit[] = [];
  for (const line of stripCouplingComments(path, text).split("\n")) {
    for (const match of line.matchAll(INSTALLED)) {
      if (
        !registry.isOurs(match[1]!) ||
        match[1] === registry.own ||
        line.slice(0, match.index).includes("@source")
      )
        continue;
      if (isAllowedOxlintExtends(path, line)) continue;
      const message = installedPackageViolation(path, match, registry);
      if (message) hits.push({ text: match[0], message });
    }
  }
  return hits;
}

export function cssImportViolation(
  path: string,
  spec: CssImportMatch,
  registry: PackageRegistry,
): string | undefined {
  const subpath = posix.normalize(spec.raw);
  const pkg = registry.manifest(spec.name);
  const published = registry.publishes(spec.name, subpath, spec.disk);
  const styles = (pkg?.scaffolding as { styles?: string[] } | undefined)?.styles ?? [];
  if (spec.name === BRAND)
    return published
      ? undefined
      : `not in the exports of ${spec.name}: import a subpath listed in ${spec.name}'s package.json exports, or add this subpath to ${spec.name}'s exports and release a new tag; do not silence with scaffolding.allow`;
  if (spec.name === SHELL)
    return path.startsWith("catalog/")
      ? undefined
      : "the catalog shell's styles load only under catalog/: remove this @hackersandwizards/scaffolding CSS import from application code and use @hackersandwizards/brand exports or local styles instead, or move the file under catalog/";
  if (!styles.some((s) => posix.normalize(s) === subpath))
    return "styles come from brand's exports, an engine's scaffolding.styles or this repository: import the stylesheet from @hackersandwizards/brand, move the CSS into this repository, or use the owning engine's composer. If the composer cannot supply the styles, declare the stylesheet in the engine's package.json scaffolding.styles and exports";
  return published
    ? undefined
    : `not in the exports of ${spec.name}: import a subpath listed in ${spec.name}'s package.json exports, or add this subpath to ${spec.name}'s exports and release a new tag; do not silence with scaffolding.allow`;
}

export function cssImportHits(
  path: string,
  text: string,
  registry: PackageRegistry,
): CouplingHit[] {
  const hits: CouplingHit[] = [];
  for (const [, disk, name, raw] of text.matchAll(CSS)) {
    // Outside a stylesheet a disk path is the installed-path rule's, which leaves a stylesheet's
    // .css paths, a Tailwind @source included, to this rule.
    if (name === registry.own || (disk !== undefined && !STYLES.test(path))) continue;
    const message = cssImportViolation(path, { name, raw, disk: disk !== undefined }, registry);
    if (message) hits.push({ text: `${name}/${raw}`, message });
  }
  return hits;
}

export function dependencyPinViolation(
  field: string,
  entry: { name: string; spec: string },
  registry: PackageRegistry,
): string | undefined {
  if (/^(?:file|link|portal):/.test(entry.spec))
    return "local path dependency: replace the file:/link:/portal: specifier in package.json with a pinned Git tag (git+https://...#vX.Y.Z) or registry version, then run bun install";
  if (!GIT.test(entry.spec)) return undefined;
  if (!TAG.test(entry.spec))
    return "Git dependency not pinned to a version tag: append a semver tag (#vX.Y.Z) to the Git URL in package.json (or run raise-pins), then run bun install";
  // A stale install renders with the old engine while every file reads the new pin.
  if (field === "peerDependencies") return undefined;
  const pinned = TAG.exec(entry.spec)![0].replace(/^#(?:semver:)?v?/, "");
  const installed = (registry.manifest(entry.name)?.version as string | undefined) ?? "nothing";
  return installed !== pinned
    ? `node_modules holds ${installed}, not the pinned ${pinned}: bun install`
    : undefined;
}

export function dependencyPinHits(
  pkg: Record<string, unknown>,
  registry: PackageRegistry,
): CouplingHit[] {
  const hits: CouplingHit[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries((pkg[field] ?? {}) as Record<string, string>)) {
      const message = dependencyPinViolation(field, { name, spec }, registry);
      if (message) hits.push({ text: `${name}@${spec}`, message });
    }
  }
  return hits;
}
