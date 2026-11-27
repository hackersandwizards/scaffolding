import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import ts from "typescript";

const playwrightPackages = new Set(["@playwright/test", "playwright/test"]);
const playwrightBindings = new Set(["test", "expect"]);

function playwrightFileText(file) {
  if (process.env.SCAFFOLDING_STAGED_ESLINT === "1") {
    const path = relative(process.cwd(), file);
    const staged = spawnSync("git", ["show", `:${path}`], {
      encoding: "utf8",
      maxBuffer: Infinity,
    });
    if (staged.status === 0) return staged.stdout;
  }
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return "";
  }
}

function hasRuntimePlaywrightExport(node) {
  if (node.isTypeOnly) return false;
  const names = node.exportClause;
  return (
    !names || !ts.isNamedExports(names) || names.elements.some((element) => !element.isTypeOnly)
  );
}

function importsPlaywrightBindings(node) {
  if (ts.isExportDeclaration(node)) return hasRuntimePlaywrightExport(node);
  if (!ts.isImportDeclaration(node)) return false;
  const clause = node.importClause;
  if (clause?.isTypeOnly) return false;
  const names = clause?.namedBindings;
  const direct = playwrightPackages.has(node.moduleSpecifier.text);
  if (!names || !ts.isNamedImports(names)) return direct;
  if (direct && clause.name) return true;
  return names.elements.some(
    (element) =>
      !element.isTypeOnly &&
      (direct || playwrightBindings.has((element.propertyName ?? element.name).text)),
  );
}

function followsPlaywrightImport(node, file, visited) {
  if (!importsPlaywrightBindings(node)) return false;
  const source = node.moduleSpecifier;
  if (!source || !ts.isStringLiteralLike(source)) return false;
  if (playwrightPackages.has(source.text)) return true;
  if (!source.text.startsWith(".")) return false;
  const { resolvedModule } = ts.resolveModuleName(
    source.text,
    file,
    { moduleResolution: ts.ModuleResolutionKind.Bundler },
    ts.sys,
  );
  return resolvedModule !== undefined && isPlaywrightFile(resolvedModule.resolvedFileName, visited);
}

export function isPlaywrightFile(file, visited = new Set()) {
  if (visited.has(file)) return false;
  visited.add(file);
  const source = ts.createSourceFile(file, playwrightFileText(file), ts.ScriptTarget.Latest);
  return source.statements.some((node) => followsPlaywrightImport(node, file, visited));
}
