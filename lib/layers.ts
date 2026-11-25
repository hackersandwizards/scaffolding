import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activeSeverity } from "./lint-rule-overlaps.ts";
import { oxlintConfig, restrictionRuleName, restrictedImports } from "./oxlint-restrictions.ts";
import { isObject, isStrings, jsonObject } from "./repo.ts";

export const layerMapPath = "docs/architecture/layers.md";

const compareLayers = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type Restriction = { pattern: string; message: string };
type Layer = { name: string };
type LayerScope = { include: string[]; exclude: Bun.Glob[] };
type DeclaredLayer = Layer & { scopes: LayerScope[]; restrictions: Restriction[] };

function normalizeLayerGlob(pattern: string) {
  const portable = pattern.replaceAll("\\", "/");
  const display = portable.replace(/^\.\//, "");
  const match = portable.includes("/") ? display : `**/${display}`;
  return { display, match };
}

function declaredLayers(root: string): DeclaredLayer[] {
  const path = join(root, oxlintConfig);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isFile()) throw new Error(`${oxlintConfig} must be a regular file`);
  const { overrides } = jsonObject(readFileSync(path));
  if (overrides === undefined) return [];
  if (!Array.isArray(overrides)) throw new Error(`${oxlintConfig}: overrides must be an array`);

  const layers = new Map<string, DeclaredLayer>();
  for (const override of overrides as unknown[]) {
    if (!isObject(override) || !isObject(override.rules)) continue;
    const rules = Object.entries(override.rules).filter(
      ([rule, setting]) =>
        restrictionRuleName(rule) === "no-restricted-imports" && activeSeverity(setting),
    );
    if (!rules.length) continue;
    if (!isStrings(override.files) || !override.files.length || override.files.includes(""))
      throw new Error(`${oxlintConfig}: each layer must declare files globs`);
    const exclude = override.excludeFiles ?? [];
    if (!isStrings(exclude)) throw new Error(`${oxlintConfig}: layer excludeFiles must list globs`);
    const globs = override.files.map(normalizeLayerGlob);
    const name = [...new Set(globs.map(({ display }) => display.replace(/\/\*\*$/, "")))]
      .sort(compareLayers)
      .join(", ");
    const layer = layers.get(name) ?? { name, scopes: [], restrictions: [] };
    layers.set(name, layer);
    layer.scopes.push({
      include: globs.map(({ match }) => match),
      exclude: exclude.map((pattern) => new Bun.Glob(normalizeLayerGlob(pattern).match)),
    });
    for (const [, setting] of rules) {
      if (!Array.isArray(setting)) continue;
      for (const { item } of restrictedImports(setting.slice(1))) {
        const value = isObject(item) ? (item.name ?? item.regex ?? item.group) : item;
        const message = isObject(item) && typeof item.message === "string" ? item.message : "";
        if (typeof value === "string") layer.restrictions.push({ pattern: value, message });
        else if (isStrings(value)) {
          for (const pattern of value) layer.restrictions.push({ pattern, message });
        }
      }
    }
  }
  return [...layers.values()].sort((a, b) => compareLayers(a.name, b.name));
}

function rankLayerGlob(pattern: string) {
  return {
    prefix: pattern.startsWith("!") ? -1 : pattern.search(/[*?[\]{}]|$/),
    literals: pattern.replace(/[*?[\]{},]/g, "").length,
    globstars: pattern.match(/\*\*/g)?.length ?? 0,
  };
}

function layerForPath(layers: DeclaredLayer[]) {
  const matchers = layers
    .flatMap((layer) =>
      layer.scopes.flatMap(({ include, exclude }) =>
        include.map((pattern) => ({
          layer,
          glob: new Bun.Glob(pattern),
          exclude,
          ...rankLayerGlob(pattern),
        })),
      ),
    )
    .sort((a, b) => b.prefix - a.prefix || b.literals - a.literals || a.globstars - b.globstars);
  const folders = new Map<string, Layer>();
  return (path: string): Layer => {
    const declared = matchers.find(
      ({ glob, exclude }) => glob.match(path) && !exclude.some((excluded) => excluded.match(path)),
    );
    if (declared) return declared.layer;
    const name = path.includes("/") ? path.split("/", 1)[0] : ".";
    const existing = folders.get(name);
    if (existing) return existing;
    const layer = { name };
    folders.set(name, layer);
    return layer;
  };
}

function importOccurrences(file: string, sourceCode?: string) {
  const typescript = /\.[cm]?tsx?$/.test(file);
  const jsx = file.endsWith("x");
  const loader = typescript ? (jsx ? "tsx" : "ts") : jsx ? "jsx" : "js";
  const counts = new Map<string, number>();
  const code = (sourceCode ?? readFileSync(file, "utf8")).replace(/^#![^\n]*/, "");
  // Dependency-cruiser collapses repeated specifiers within one file and module system.
  for (const { path, kind } of new Bun.Transpiler({ loader }).scanImports(code)) {
    const system = kind === "require-call" || kind === "require-resolve" ? "cjs" : "es6";
    const key = `${system}:${path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function layerCodeSpan(text: string) {
  if (!text) return "";
  const content = text.replaceAll("|", "\\|");
  const runs = new Set(Array.from(content.matchAll(/`+/g), (run) => run[0].length));
  let size = 1;
  while (runs.has(size)) size++;
  const ticks = "`".repeat(size);
  const padding =
    content.startsWith("`") ||
    content.endsWith("`") ||
    (content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content))
      ? " "
      : "";
  return `${ticks}${padding}${content}${padding}${ticks}`;
}

function layerTableCell(text: string) {
  // GFM treats pipes preceded by an even number of backslashes as cell boundaries.
  return text
    .split(/\r\n|\r|\n/)
    .map((line) =>
      line
        .split(/(?<=\\)(?=\|)/)
        .map(layerCodeSpan)
        .join("<!-- -->"),
    )
    .join("<br>");
}

function restrictionTable(restrictions: Restriction[]) {
  const rows = restrictions
    .toSorted((a, b) => compareLayers(a.pattern, b.pattern) || compareLayers(a.message, b.message))
    .map(({ pattern, message }) => [layerTableCell(pattern), layerTableCell(message)] as const);
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
  const { complete, findings } = await inspectImportGraph(
    root,
    (source, file, imports, sourceCode) => {
      const from = layerFor(source);
      const otherLayers = imports
        .map((dependency) => ({ ...dependency, to: layerFor(dependency.target) }))
        .filter(({ to }) => from !== to);
      if (!otherLayers.length) return;
      const occurrences = importOccurrences(file, sourceCode);
      const targets = edges.get(from) ?? new Map<Layer, number>();
      edges.set(from, targets);
      nodes.add(from);
      for (const { to, specifier, system } of otherLayers) {
        nodes.add(to);
        const count = occurrences.get(`${system}:${specifier}`) ?? 1;
        targets.set(to, (targets.get(to) ?? 0) + count);
      }
    },
  );
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
