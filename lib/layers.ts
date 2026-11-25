import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activeSeverity } from "./lint-rule-overlaps.ts";
import { oxlintConfig, restrictionRuleName, restrictedImports } from "./oxlint-restrictions.ts";
import { isObject, isStrings, jsonObject } from "./repo.ts";

export const layerMapPath = "docs/architecture/layers.md";

const compareLayers = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type Restriction = { pattern: string; message: string };
type Layer = { name: string };
type DeclaredLayer = Layer & { globs: string[]; restrictions: Restriction[] };

function declaredLayers(root: string): DeclaredLayer[] {
  const path = join(root, oxlintConfig);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isFile()) throw new Error(`${oxlintConfig} must be a regular file`);
  const { overrides } = jsonObject(readFileSync(path));
  if (overrides === undefined) return [];
  if (!Array.isArray(overrides)) throw new Error(`${oxlintConfig}: overrides must be an array`);

  const layers: DeclaredLayer[] = [];
  for (const override of overrides as unknown[]) {
    if (!isObject(override) || !isObject(override.rules)) continue;
    const rules = Object.entries(override.rules).filter(
      ([rule, setting]) =>
        restrictionRuleName(rule) === "no-restricted-imports" && activeSeverity(setting),
    );
    if (!rules.length) continue;
    if (!isStrings(override.files) || !override.files.length || override.files.includes(""))
      throw new Error(`${oxlintConfig}: each layer must declare files globs`);
    const globs = [...override.files].sort(compareLayers);
    const restrictions: Restriction[] = [];
    for (const [, setting] of rules) {
      if (!Array.isArray(setting)) continue;
      for (const { item } of restrictedImports(setting.slice(1))) {
        const value = isObject(item) ? (item.name ?? item.regex ?? item.group) : item;
        const message = isObject(item) && typeof item.message === "string" ? item.message : "";
        if (typeof value === "string") restrictions.push({ pattern: value, message });
        else if (isStrings(value)) {
          for (const pattern of value) restrictions.push({ pattern, message });
        }
      }
    }
    layers.push({
      name: globs.map((glob) => glob.replace(/\/\*\*$/, "")).join(", "),
      globs,
      restrictions,
    });
  }
  return layers.sort((a, b) => compareLayers(a.name, b.name));
}

function literalPrefix(glob: string) {
  return glob.match(/^(?:\\.|[^*?[\]{}\\])*/)?.[0].replace(/\\(.)/g, "$1").length ?? 0;
}

function layerForPath(layers: DeclaredLayer[]) {
  const matchers = layers
    .flatMap((layer) =>
      layer.globs.map((glob) => ({
        layer,
        glob: new Bun.Glob(glob),
        specificity: literalPrefix(glob),
      })),
    )
    .sort((a, b) => b.specificity - a.specificity);
  const folders = new Map<string, Layer>();
  return (path: string): Layer => {
    const declared = matchers.find(({ glob }) => glob.match(path));
    if (declared) return declared.layer;
    const name = path.includes("/") ? path.split("/", 1)[0] : ".";
    const existing = folders.get(name);
    if (existing) return existing;
    const layer = { name };
    folders.set(name, layer);
    return layer;
  };
}

function importOccurrences(file: string) {
  const typescript = /\.[cm]?tsx?$/.test(file);
  const jsx = file.endsWith("x");
  const loader = typescript ? (jsx ? "tsx" : "ts") : jsx ? "jsx" : "js";
  const counts = new Map<string, number>();
  const code = readFileSync(file, "utf8").replace(/^#![^\n]*/, "");
  // Dependency-cruiser collapses repeated specifiers within one file and module system.
  for (const { path, kind } of new Bun.Transpiler({ loader }).scanImports(code)) {
    const system = kind === "require-call" || kind === "require-resolve" ? "cjs" : "es6";
    const key = `${system}:${path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function tableCell(text: string) {
  return text.replaceAll("|", "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

function restrictionTable(restrictions: Restriction[]) {
  const rows = restrictions
    .toSorted((a, b) => compareLayers(a.pattern, b.pattern) || compareLayers(a.message, b.message))
    .map(({ pattern, message }) => {
      const ticks = "`".repeat(
        1 + Math.max(0, ...Array.from(pattern.matchAll(/`+/g), (run) => run[0].length)),
      );
      const padding = /^`|\s$|^\s|`$/.test(pattern) ? " " : "";
      return [
        `${ticks}${padding}${tableCell(pattern)}${padding}${ticks}`,
        tableCell(message),
      ] as const;
    });
  const header = ["Forbidden import", "Message"] as const;
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map((row) => Bun.stringWidth(row[i]))),
  );
  const line = (row: readonly string[]) =>
    `| ${row.map((cell, i) => cell + " ".repeat(widths[i] - Bun.stringWidth(cell))).join(" | ")} |`;
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
}

export async function renderLayers(root: string) {
  const layers = declaredLayers(root);
  if (!layers.length) return;
  const { inspectImportGraph } = await import("./import-graph.ts");
  const layerFor = layerForPath(layers);
  const nodes = new Set<Layer>(layers);
  const edges = new Map<Layer, Map<Layer, number>>();
  const { complete, findings } = await inspectImportGraph(root, (source, file, imports) => {
    const from = layerFor(source);
    const otherLayers = imports
      .map((dependency) => ({ ...dependency, to: layerFor(dependency.target) }))
      .filter(({ to }) => from !== to);
    if (!otherLayers.length) return;
    const occurrences = importOccurrences(file);
    const targets = edges.get(from) ?? new Map<Layer, number>();
    edges.set(from, targets);
    nodes.add(from);
    for (const { to, specifier, system } of otherLayers) {
      nodes.add(to);
      const count = occurrences.get(`${system}:${specifier}`) ?? 1;
      targets.set(to, (targets.get(to) ?? 0) + count);
    }
  });
  if (!complete)
    throw new Error(findings.map(({ path, message }) => `${path}: ${message}`).join("\n"));

  const order = [...nodes].sort((a, b) => compareLayers(a.name, b.name));
  const graph = order.map(
    ({ name }, i) => `  L${i}["${name.replace(/[#"<>&]/g, (char) => `#${char.charCodeAt(0)};`)}"]`,
  );
  for (const [i, from] of order.entries()) {
    const targets = edges.get(from);
    if (!targets) continue;
    for (const [j, to] of order.entries()) {
      const count = targets.get(to);
      if (count) graph.push(`  L${i} -->|${count}| L${j}`);
    }
  }

  const sections = layers.flatMap(({ name, restrictions }) => [
    "",
    `## ${name.replace(/[\\*_`[\]<>]/g, "\\$&")}`,
    "",
    ...restrictionTable(restrictions),
  ]);
  return ["# Layers", "", "```mermaid", "graph LR", ...graph, "```", ...sections, ""].join("\n");
}
