import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activeSeverity } from "./lint-rule-overlaps.ts";
import {
  oxlintConfig,
  parseOxlintConfig,
  restrictionRuleName,
  restrictedImports,
} from "./oxlint-restrictions.ts";
import { isObject, isStrings } from "./repo.ts";

export const layerMapPath = "docs/architecture/layers.md";

const compareLayers = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type Restriction = { pattern: string; message: string };
export type Layer = { name: string };
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
  if (!stat.isFile())
    throw new Error(
      `The layer map reads its rules from ${oxlintConfig}. Replace that path with a regular Oxlint config file.`,
    );
  const config = readFileSync(path, "utf8");
  let overrides: unknown;
  try {
    ({ overrides } = parseOxlintConfig(config));
  } catch (error) {
    throw new Error(
      `${oxlintConfig}: cannot parse the config (${(error as Error).message}). Fix the config so it is a valid JSON object.`,
      { cause: error },
    );
  }
  if (overrides === undefined) return [];
  if (!Array.isArray(overrides))
    throw new Error(
      `${oxlintConfig}: the layer map reads layer declarations from the overrides array. Set overrides to an array of Oxlint override objects or omit it if there are no overrides.`,
    );

  return mergeLayerDeclarations(overrides);
}

export function normalizeLayerRestrictions(setting: unknown[]): Restriction[] {
  const restrictions: Restriction[] = [];
  for (const { item } of restrictedImports(setting.slice(1))) {
    const value = isObject(item) ? (item.name ?? item.regex ?? item.group) : item;
    const message = isObject(item) && typeof item.message === "string" ? item.message : "";
    if (typeof value === "string") restrictions.push({ pattern: value, message });
    else if (isStrings(value)) {
      for (const pattern of value) restrictions.push({ pattern, message });
    }
  }

  return restrictions;
}

export function parseLayerOverride(override: unknown): DeclaredLayer | undefined {
  if (!isObject(override) || !isObject(override.rules)) return;
  const rules = Object.entries(override.rules).filter(
    ([rule, setting]) =>
      restrictionRuleName(rule) === "no-restricted-imports" && activeSeverity(setting),
  );
  if (!rules.length) return;
  if (!isStrings(override.files) || !override.files.length || override.files.includes(""))
    throw new Error(
      `${oxlintConfig}: the layer map needs to know which files the override covers. Set files on the layer override to a non-empty array of non-empty globs.`,
    );
  const exclude = override.excludeFiles ?? [];
  if (!isStrings(exclude) || exclude.includes(""))
    throw new Error(
      `${oxlintConfig}: the layer map cannot apply invalid excludeFiles globs. Set excludeFiles on the layer override to an array of non-empty globs, or omit it.`,
    );
  const globs = override.files.map(normalizeLayerGlob);
  const name = [...new Set(globs.map(({ display }) => display.replace(/\/\*\*$/, "")))]
    .sort(compareLayers)
    .join(", ");
  return {
    name,
    scopes: [
      {
        include: globs.map(({ match }) => match),
        exclude: exclude.map((pattern) => new Bun.Glob(normalizeLayerGlob(pattern).match)),
      },
    ],
    restrictions: rules
      .map(([, setting]) => setting)
      .filter(Array.isArray)
      .flatMap(normalizeLayerRestrictions),
  };
}

export function mergeLayerDeclarations(overrides: unknown[]): DeclaredLayer[] {
  const layers = new Map<string, DeclaredLayer>();
  for (const override of overrides) {
    const declaration = parseLayerOverride(override);
    if (!declaration) continue;
    const existing = layers.get(declaration.name);
    if (existing) {
      existing.scopes.push(...declaration.scopes);
      existing.restrictions.push(...declaration.restrictions);
    } else layers.set(declaration.name, declaration);
  }
  return [...layers.values()].sort((a, b) => compareLayers(a.name, b.name));
}

function rankLayerGlob(pattern: string) {
  let literals = pattern.replace(/[*?[\]]/g, "");
  const braceGroup = /\{([^{}]*)\}/g;
  while (/\{[^{}]*\}/.test(literals))
    literals = literals.replace(braceGroup, (_, alternatives: string) =>
      alternatives
        .split(",")
        .reduce((shortest, option) => (option.length < shortest.length ? option : shortest)),
    );
  return {
    prefix: pattern.startsWith("!") ? -1 : pattern.search(/[*?[\]{}]|$/),
    literals: literals.length,
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
    .sort((a, b) => b.prefix - a.prefix || a.globstars - b.globstars || b.literals - a.literals);
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

function importOccurrences(source: string, file: string, sourceCode?: string) {
  const typescript = /\.[cm]?tsx?$/.test(file);
  const loader = typescript ? (file.endsWith("x") ? "tsx" : "ts") : "jsx";
  const counts = new Map<string, number>();
  const code = (sourceCode ?? readFileSync(file, "utf8")).replace(/^#![^\n]*/, "");
  let imports;
  try {
    imports = new Bun.Transpiler({ loader }).scanImports(code);
  } catch (error) {
    throw new Error(
      `${source}: cannot scan imports (${(error as Error).message}). Fix the source syntax and rerun \`bun run scaffolding layers\`.`,
      { cause: error },
    );
  }
  // Dependency-cruiser collapses repeated specifiers within one file and module system.
  for (const { path, kind } of imports) {
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

export function layerDiagram(
  layers: Layer[],
  nodes: ReadonlySet<Layer>,
  edges: ReadonlyMap<Layer, ReadonlyMap<Layer, number>>,
): string[] {
  const declaredNames = new Set(layers.map(({ name }) => name));
  const usedNames = new Set([...nodes].map(({ name }) => name));
  for (const layer of nodes) {
    if ("scopes" in layer || !declaredNames.has(layer.name)) continue;
    do {
      layer.name += " (outside layers)";
    } while (usedNames.has(layer.name));
    usedNames.add(layer.name);
  }
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
  return graph;
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
    ({ source, file, imports, sourceCode }) => {
      const from = layerFor(source);
      const otherLayers = imports
        .map((dependency) => ({ ...dependency, to: layerFor(dependency.target) }))
        .filter(({ to }) => from !== to);
      if (!otherLayers.length) return;
      const occurrences = importOccurrences(source, file, sourceCode);
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

  const graph = layerDiagram(layers, nodes, edges);

  const sections = layers.flatMap(({ name, restrictions }) => [
    "",
    `## ${name.replace(/[\\*_`[\]<>]/g, "\\$&")}`,
    "",
    ...restrictionTable(restrictions),
  ]);
  return ["# Layers", "", "```mermaid", "graph LR", ...graph, "```", ...sections, ""].join("\n");
}
