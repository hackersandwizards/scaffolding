import { existsSync } from "node:fs";
import { basename, join, posix } from "node:path";
import type { Node } from "typescript";
import { placedSteps } from "./gate-config.ts";
import { isObject, isReason, type Package } from "./repo.ts";

export type StructureHit = { path: string; message: string; text: string };
export type PackageExpectations = {
  type: string;
  "engines.npm": string;
  packageManager: string;
  scripts: readonly string[];
  catalogScripts: readonly string[];
};

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function ownedTemplateMatches(text: string, template: string, commit: string): boolean {
  const [before = "", after = ""] = template.split("{{commit}}");
  const pinned = text.slice(before.length, text.length - after.length);
  return (
    text.startsWith(before) &&
    text.endsWith(after) &&
    /^[0-9a-f]{40}$/.test(pinned) &&
    pinned.startsWith(commit)
  );
}

export function mergeSkeletonList(has: unknown, wanted: readonly unknown[]): unknown[] {
  const isSkeletonItem = (item: unknown) =>
    wanted.some(
      (expected) =>
        sameJson(item, expected) ||
        (isObject(item) && isObject(expected) && item.matcher === expected.matcher),
    );
  const kept: unknown[] = Array.isArray(has) ? has : [];
  return [...wanted, ...kept.filter((item) => !isSkeletonItem(item))];
}

export function mergeSkeletonEntry(
  file: unknown,
  template: Record<string, unknown>,
  key: readonly string[],
): "ok" | "invalid-parent" | "updated" {
  // The object holding the key, created on the way where missing; none where a value in the way
  // is no object, which no repair can mend.
  let holder: unknown = file;
  for (const part of key.slice(0, -1))
    holder = isObject(holder) ? (holder[part] ??= {}) : undefined;
  const want = key.reduce<unknown>((v, k) => (v as Record<string, unknown>)[k], template);
  if (!isObject(holder)) return "invalid-parent";
  const leaf = key.at(-1)!;
  const has = holder[leaf];
  const next = Array.isArray(want) ? mergeSkeletonList(has, want) : want;
  if (sameJson(has, next)) return "ok";
  holder[leaf] = next;
  return "updated";
}

export function mergeSkeletonEntries(
  file: unknown,
  template: Record<string, unknown>,
  keys: readonly (readonly string[])[],
): { invalidParents: string[]; differ: string[] } {
  const invalidParents: string[] = [];
  const differ: string[] = [];
  for (const key of keys) {
    const status = mergeSkeletonEntry(file, template, key);
    if (status === "invalid-parent") invalidParents.push(key.join("."));
    else if (status === "updated") differ.push(key.join("."));
  }
  return { invalidParents, differ };
}

export function usesSharedVitest(config: string): boolean {
  const specifier = "@hackersandwizards/scaffolding/vitest";
  if (!config.includes(specifier)) return false;
  // Read the static export forms after Bun strips comments and TypeScript syntax.
  let js: string;
  try {
    js = new Bun.Transpiler({ loader: "ts" }).transformSync(config);
  } catch {
    return false;
  }
  if (/^export \{ default \} from "@hackersandwizards\/scaffolding\/vitest";$/m.test(js))
    return true;
  const imported = js.match(
    /^import ([\w$]+) from "@hackersandwizards\/scaffolding\/vitest";$/m,
  )?.[1];
  const used = js.match(/^export default (?:mergeConfig\(([\w$]+),|([\w$]+);$)/m);
  return imported !== undefined && imported === (used?.[1] ?? used?.[2]);
}

export function runsMutationWrapper(script: unknown, ownBin?: string): boolean {
  if (typeof script !== "string") return false;
  const command = script.match(
    /^\s*(?:env\s+)?(?:[a-zA-Z_]\w*=(?:'[^']*'|"[^"]*"|[^\s'";&|<>])*\s+)*(?:bun\s+(?:(?:run|--bun|--no-env-file)\s+)*)?(['"]?)([^\s'";&|<>]+)\1(?=$|[\s;&|<>])/,
  )?.[2];
  return command === "scaffolding-mutation" || (ownBin !== undefined && command === ownBin);
}

export async function mutationLineRangeEntries(path: string, text: string): Promise<string[]> {
  const ts = await import("typescript");
  const config = path.endsWith(".json")
    ? ts.parseJsonText(path, text)
    : ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
  const ranges: string[] = [];
  const visit = (node: Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === "mutate" &&
      ts.isArrayLiteralExpression(node.initializer)
    )
      for (const entry of node.initializer.elements)
        if (ts.isStringLiteralLike(entry) && /:\d+(?::\d+)?-\d+(?::\d+)?$/.test(entry.text))
          ranges.push(entry.text);
    ts.forEachChild(node, visit);
  };
  visit(config);
  return ranges;
}

export function reachableScriptCommands(entry: string, scripts: Record<string, string>): string[] {
  // The command, and each script it runs, at any depth: the value itself where it names one, as
  // the gate runs it, and each `run <name>` (`bun run test` naming `test:unit`). `bun test` is
  // bun's runner, never the script named test.
  const read = Object.hasOwn(scripts, entry) ? [entry, scripts[entry]] : [entry];
  for (const text of read) {
    for (const [, name] of text.matchAll(/\brun\s+(?:--?\S+\s+)*([^\s;&|]+)/g)) {
      if (Object.hasOwn(scripts, name) && !read.includes(scripts[name])) read.push(scripts[name]);
    }
  }
  return read;
}

export function hasStrykerDependency(pkg: Package): boolean {
  return [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.optionalDependencies,
    pkg.peerDependencies,
  ].some(
    (deps) =>
      isObject(deps) && Object.keys(deps).some((name) => name.startsWith("@stryker-mutator/")),
  );
}

export function testTimeoutConfigured(
  entry: string,
  scripts: Record<string, string>,
  configTexts: readonly string[],
): boolean {
  const read = reachableScriptCommands(entry, scripts);
  return (
    [...read, ...configTexts].some((text) => text.includes("SCAFFOLDING_TEST_TIMEOUT_MS")) ||
    configTexts.some(usesSharedVitest)
  );
}

export async function loadPrettier(root: string): Promise<typeof import("prettier") | undefined> {
  // Prettier's own resolution, so the rules count from any config form, the shared one included.
  const prettierEntry = join(root, "node_modules/prettier/index.mjs");
  const loaded: unknown = await import(
    existsSync(prettierEntry) ? prettierEntry : "prettier"
  ).catch(() => undefined);
  const isPrettier = (module: unknown): module is typeof import("prettier") =>
    isObject(module) &&
    typeof module.resolveConfig === "function" &&
    typeof module.format === "function";
  return isPrettier(loaded) ? loaded : undefined;
}

export function prettierConfigFindings(
  rc: Record<string, unknown>,
  expected: Record<string, unknown>,
): StructureHit[] {
  const hits: StructureHit[] = [];
  for (const [key, value] of Object.entries(expected))
    if (rc[key] !== value)
      hits.push({
        path: "prettier config",
        message: `${key} must be ${JSON.stringify(value)}: update prettier.config.js (or re-export @hackersandwizards/scaffolding/prettier) so ${key} is ${JSON.stringify(value)}`,
        text: `${key}: ${JSON.stringify(rc[key])}`,
      });
  return hits;
}

export function missingScriptsFindings(
  pkg: Package,
  baseScripts: readonly string[],
  catalogScripts: readonly string[],
): StructureHit[] {
  const hits: StructureHit[] = [];
  const surface = !isReason(pkg.scaffolding?.skip?.catalog);
  const scripts = [...baseScripts, ...(surface ? catalogScripts : [])];
  for (const script of scripts)
    if (!pkg.scripts?.[script])
      hits.push({
        path: "package.json",
        message: `script ${script} missing: add "${script}" under "scripts" in package.json (or if this is a catalog script and the repo has no catalog, set scaffolding.skip.catalog with a reason)`,
        text: script,
      });
  return hits;
}

export function packageManifestFindings(
  pkg: Package,
  expected: PackageExpectations,
): StructureHit[] {
  const hits: StructureHit[] = [];
  if (pkg.type !== expected.type)
    hits.push({
      path: "package.json",
      message: `type must be ${expected.type}: set "type": ${JSON.stringify(expected.type)} in package.json`,
      text: "",
    });
  if (pkg.engines?.npm !== expected["engines.npm"])
    hits.push({
      path: "package.json",
      message: `engines.npm must be ${expected["engines.npm"]}: set "engines": { "npm": ${JSON.stringify(expected["engines.npm"])} } in package.json`,
      text: "",
    });
  if (pkg.packageManager !== expected.packageManager)
    hits.push({
      path: "package.json",
      message: `packageManager must be ${expected.packageManager}: set "packageManager": ${JSON.stringify(expected.packageManager)} in package.json`,
      text: String(pkg.packageManager),
    });
  return [...hits, ...missingScriptsFindings(pkg, expected.scripts, expected.catalogScripts)];
}

export function missingSkeletonFileMessage(path: string): string {
  return (
    "missing: create this required skeleton file (see @hackersandwizards/scaffolding skeleton.json)" +
    (path === "LICENSE"
      ? ", or if this is a private repository and LICENSE is missing, set scaffolding.private: true in package.json"
      : "")
  );
}

export function checkStepFindings(pkg: Package): StructureHit[] {
  const hits: StructureHit[] = [];
  for (const step of (pkg.scaffolding?.check ?? []).flat())
    if (!placedSteps.has(step) && (!/^check:[a-z0-9][\w:-]*$/.test(step) || !pkg.scripts?.[step]))
      hits.push({
        path: "package.json",
        message:
          "a step of scaffolding.check is a script named check:<what>: rename the step and its package.json script to check:<what>, or use a built-in placed step (colours, copies, retired, elements, links, browser-test)",
        text: step,
      });
  return hits;
}

export function normalizedBinPaths(pkg: Package): string[] {
  const raw = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
  return [...new Set(raw.map((p) => posix.normalize(String(p))))];
}

export function isStrykerConfigPath(path: string): boolean {
  return /^(?:stryker\.config\..+|\.?stryker\.(?:conf|config)\.(?:[cm]?js|json))$/.test(
    basename(path),
  );
}

export function nonExecutableIndexEntries(
  lsFilesOutput: string,
): { mode: string; blob: string; path: string }[] {
  const entries: { mode: string; blob: string; path: string }[] = [];
  for (const entry of lsFilesOutput.split("\0").filter(Boolean)) {
    const [, mode, blob, stage, path] = /^(\d+) (\S+) (\d)\t(.*)$/s.exec(entry)!;
    // An unmerged path waits for its merge.
    if (mode === "100644" && stage === "0") entries.push({ mode, blob, path });
  }
  return entries;
}

export function hookIndexMode(lsFilesOutput: string): { mode?: string; blob?: string } {
  const match = /^(\d+) (\S+)/.exec(lsFilesOutput);
  return { mode: match?.[1], blob: match?.[2] };
}

export function hasCatalogPresetImport(configTexts: readonly string[], preset: string): boolean {
  const uses = new RegExp(`from\\s*["']${preset.replace(/[/.]/g, "\\$&")}["']`);
  return configTexts.some((text) => uses.test(text));
}

export function catalogPresetMissingMessage(preset: string): string {
  return `the Astro config must use the catalog preset from ${preset}: import { catalog } from "${preset}" and add catalog(...) to integrations in the Astro config, or set scaffolding.skip.catalog with a reason in package.json if this repo has no UI catalog`;
}

export function findGenericFolders(trackedPaths: readonly string[]): string[] {
  const genericFolders = new Set<string>();
  for (const path of trackedPaths)
    for (let folder = posix.dirname(path); folder !== "."; folder = posix.dirname(folder))
      if (/^(?:utils|helpers|common|shared|core)$/i.test(posix.basename(folder)))
        genericFolders.add(folder);
  return [...genericFolders].sort();
}
