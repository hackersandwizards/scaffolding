// Every module-scope function name outside tests is defined once, so a grep for its definition
// finds one site.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Arguments: the names the repository's framework dictates.
const frameworkNames = new Set(process.argv.slice(2));

function scriptSource(file: string): string {
  const text = readFileSync(file, "utf8");
  if (!file.endsWith(".astro")) return text;
  // Blank all but the frontmatter and script bodies, keeping newlines, so reported lines match the file.
  const kept = [
    text.match(/^---\n([\s\S]*?)\n---/d),
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

const testFile = /(^|\/)(__tests__|tests?|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

const sites = new Map<string, string[]>();
const files = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "*.ts",
    "*.tsx",
    "*.mts",
    "*.cts",
    "*.js",
    "*.mjs",
    "*.cjs",
    "*.astro",
  ],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(
    (file) =>
      file &&
      resolve(file) !== fileURLToPath(import.meta.url) &&
      !file.endsWith(".d.ts") &&
      !testFile.test(file) &&
      existsSync(file),
  );
if (!files.length) throw new Error("no source files matched, so nothing was checked");
for (const file of new Set(files)) {
  const source = ts.createSourceFile(
    file.replace(/\.astro$/, ".ts"),
    scriptSource(file),
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

const duplicates = [...sites].filter(([, where]) => where.length > 1);
for (const [name, where] of duplicates)
  console.error(`${name} is defined ${where.length} times: ${where.join(", ")}`);
if (duplicates.length) {
  console.error(
    `\n${duplicates.length} function name(s) defined more than once. Rename one site or share one definition.`,
  );
  process.exit(1);
}
