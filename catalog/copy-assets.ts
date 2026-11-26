import { cpSync, existsSync, globSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, matchesGlob, posix } from "node:path";
import { isObject, jsonObject } from "../lib/json.ts";

const POINTER = "version https://git-lfs.github.com/spec/";
// A pointer file is under 200 bytes, so a larger file is read no further.
const isPointer = (file: string) => {
  if (statSync(file).size > 1024) return false;
  return readFileSync(file).subarray(0, POINTER.length).toString() === POINTER;
};

// A stylesheet or font served without its type is refused by the browser.
const TYPES = new Map(
  Object.entries({
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    webp: "image/webp",
    ico: "image/x-icon",
    woff2: "font/woff2",
    pdf: "application/pdf",
  }),
);
export const catalogAssetMime = (file: string) =>
  TYPES.get(file.split(".").pop()!.toLowerCase()) ?? "application/octet-stream";

export const catalogPackageOf = (spec: string) =>
  spec.startsWith(".") || spec.startsWith("/")
    ? undefined
    : spec
        .split("/")
        .slice(0, spec.startsWith("@") ? 2 : 1)
        .join("/");

export function catalogCopyPrefixes(patterns: string[]): [string, string][] {
  // Each `copy` entry with the folder every match lies in: the segments before its first
  // wildcard.
  return patterns.map((pattern) => [
    pattern,
    posix.normalize(pattern.replace(/(?:^|\/)[^/]*[*?[{].*$/, "")).replace(/^\.$|\/$/, ""),
  ]);
}

export function readCatalogPackage(repo: string) {
  const pkgFile = join(repo, "package.json");
  const pkg = existsSync(pkgFile) ? jsonObject(readFileSync(pkgFile)) : {};
  const name = String(pkg.name ?? basename(repo)).replace(/^@[^/]+\//, "");
  const names = (field: unknown) => (isObject(field) ? Object.keys(field) : []);
  // A package the repository declares, or its own, unless a folder of the repository has
  // that name.
  const declared = new Set([
    pkg.name,
    ...names(pkg.dependencies),
    ...names(pkg.devDependencies),
    ...names(pkg.peerDependencies),
    ...names(pkg.optionalDependencies),
  ]);
  const require = createRequire(pkgFile);
  return { repo, pkg, name, declared, require };
}

export class CatalogCopies {
  repo = "";
  // Each `copy` entry naming a package path, with the file the package's exports give it.
  resolved = new Map<string, string>();
  globbed = new Map<string, [string, string][]>();

  resolve(patterns: string[], project: ReturnType<typeof readCatalogPackage>) {
    const { repo, declared, require } = project;
    this.repo = repo;
    for (const pattern of patterns) {
      const owner = catalogPackageOf(pattern);
      if (!owner || !declared.has(owner) || existsSync(join(repo, owner))) continue;
      try {
        this.resolved.set(pattern, require.resolve(pattern));
      } catch {
        throw new Error(`catalog copy: ${pattern} is no file in the exports of ${owner}`);
      }
    }
  }

  /** A `copy` entry as [path in the build, file or folder it copies]: a package path once, a glob
   * once per match, globbed again only when `fresh` (a glob under ** walks node_modules). */
  copied(pattern: string, fresh = false): [string, string][] {
    const file = this.resolved.get(pattern);
    if (file) return [[pattern, file]];
    if (fresh || !this.globbed.has(pattern))
      this.globbed.set(
        pattern,
        globSync(pattern, { cwd: this.repo }).map((match) => [match, join(this.repo, match)]),
      );
    return this.globbed.get(pattern)!;
  }

  servePath(file: string, fixed: [string, string][]): string | undefined {
    // A file added since the last glob is found on a second pass, which globs only a pattern
    // the path or a folder above it matches: every other request misses without a glob.
    const matched = (pattern: string) => {
      for (let at = file; at !== "." && at !== "/"; at = posix.dirname(at))
        if (matchesGlob(at, pattern)) return true;
      return false;
    };
    const find = (fresh: boolean) =>
      fixed
        .filter(([, prefix]) => !prefix || file === prefix || file.startsWith(`${prefix}/`))
        .filter(([pattern]) => !fresh || this.resolved.has(pattern) || matched(pattern))
        .flatMap(([pattern]) => this.copied(pattern, fresh))
        .find(([at]) => file === at || file.startsWith(`${at}/`));
    const match = find(false) ?? find(true);
    const full = match && join(match[1], file.slice(match[0].length));
    if (
      !full ||
      file.split("/").includes("..") ||
      !statSync(full, { throwIfNoEntry: false })?.isFile()
    )
      return undefined;
    return full;
  }

  build(out: string, patterns: string[]): void {
    const pointers: string[] = [];
    for (const pattern of patterns) {
      const found = this.copied(pattern, true);
      if (found.length === 0) throw new Error(`catalog copy: ${pattern} matches nothing`);
      for (const [file, source] of found) {
        const target = join(out, file);
        cpSync(source, target, { recursive: true, dereference: true });
        // Only in CI: locally a pointer may be a file .lfsconfig leaves out.
        if (process.env.CI !== "true") continue;
        const files = statSync(target).isDirectory()
          ? readdirSync(target, { recursive: true, encoding: "utf8" }).map((f) => join(file, f))
          : [file];
        for (const f of files)
          if (statSync(join(out, f)).isFile() && isPointer(join(out, f))) pointers.push(f);
      }
    }
    if (pointers.length)
      throw new Error(`catalog copy: still Git LFS pointers: ${pointers.join(", ")}`);
  }
}
