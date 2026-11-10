#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
// Every module-scope function name is defined once, so a grep for its definition finds one site.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { applyAllow, listFiles, readPackage, repoRoot, TEST, type Finding } from "../lib/repo.ts";

function scriptSource(file: string): string {
  const text = readFileSync(file, "utf8");
  if (!file.endsWith(".astro")) return text;
  // Blank all but the frontmatter and script bodies, keeping newlines, so reported lines match the file.
  const kept = [
    text.match(/^---\r?\n([\s\S]*?)\r?\n---/d),
    ...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/dg),
  ].flatMap((m) => (m?.indices?.[1] ? [m.indices[1]] : []));
  let out = "";
  let at = 0;
  for (const [start, end] of kept) {
    out += text.slice(at, start).replace(/[^\n]/g, " ") + text.slice(start, end);
    at = end;
  }
  return out + text.slice(at).replace(/[^\n]/g, " ");
}

const sites = new Map<string, string[]>();
const root = repoRoot();
const pkg = readPackage(root);
const frameworkNames = new Set([pkg.scaffolding?.uniqueNames ?? []].flat());
const files = listFiles(root, false).filter(
  (file) => /\.(?:[cm]?[jt]s|tsx|astro)$/.test(file) && !file.endsWith(".d.ts") && !TEST.test(file),
);
if (!files.length) throw new Error("no source files matched, so nothing was checked");
for (const file of files) {
  const source = ts.createSourceFile(
    file.replace(/\.astro$/, ".ts"),
    scriptSource(join(root, file)),
    ts.ScriptTarget.Latest,
    true,
  );
  const record = (name: string, node: ts.Node) => {
    if (frameworkNames.has(name)) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    sites.set(name, [...(sites.get(name) ?? []), `${file}:${line}`]);
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
      record(statement.name.text, statement);
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const init = declaration.initializer;
      if (
        ts.isIdentifier(declaration.name) &&
        init &&
        (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
      )
        record(declaration.name.text, declaration);
    }
  }
}

const found: Finding[] = [...sites]
  .filter(([, where]) => where.length > 1)
  .flatMap(([name, where]) =>
    where.map((site) => ({
      check: "unique-names",
      path: site.slice(0, site.lastIndexOf(":")),
      text: name,
      message: site,
    })),
  );
const kept = applyAllow(pkg, "unique-names", found, true);
const entries = kept.filter((f) => f.path === "package.json");
const left = new Map<string, string[]>();
for (const f of kept)
  if (f.path !== "package.json") left.set(f.text, [...(left.get(f.text) ?? []), f.message]);
const duplicates = [...left].filter(([, where]) => where.length > 1);
for (const [name, where] of duplicates)
  console.error(`${name} is defined ${where.length} times: ${where.join(", ")}`);
for (const f of entries) console.error(`[unique-names] package.json: ${f.message} (${f.text})`);
if (duplicates.length || entries.length) {
  if (duplicates.length)
    console.error(
      `\n${duplicates.length} function name(s) defined more than once. Rename one site or share one definition.`,
    );
  process.exit(1);
}
