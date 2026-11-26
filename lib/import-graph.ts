import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { allExtensions } from "dependency-cruiser";
import { checkAstroImports } from "./astro-imports.ts";
import {
  checkImports,
  cycleFinding,
  ImportOrigin,
  sourceExtension,
  type GraphResult,
  type VisitImports,
} from "./import-scan.ts";
import { git, submodulePaths } from "./repo.ts";

export async function inspectImportGraph(
  directory: string,
  visit?: VisitImports,
): Promise<GraphResult> {
  const root = realpathSync(directory);
  const submodules = submodulePaths(root);
  const insideSubmodule = (path: string) =>
    submodules.some((submodule) => path === submodule || path.startsWith(`${submodule}/`));
  const files = git(["ls-files", "-z", "--cached", "--deduplicate"], root)
    .toString()
    .split("\0")
    .filter((path) => path && !insideSubmodule(path) && existsSync(join(root, path)));
  const sources = files.filter((path) => sourceExtension.test(path));
  const astro = files.filter((path) => path.endsWith(".astro"));
  if (sources.length === 0 && astro.length === 0) return { complete: true, findings: [] };
  // Without a TypeScript compiler, dependency-cruiser silently skips TypeScript modules.
  if (
    (astro.length > 0 || sources.some((path) => /\.[cm]?tsx?$/.test(path))) &&
    !allExtensions.some((e) => e.extension === ".ts" && e.available)
  )
    return {
      complete: false,
      findings: [cycleFinding("dependency-cruiser cannot read TypeScript here: run bun install")],
    };

  const visitLocal: VisitImports | undefined =
    visit &&
    ((module) => {
      if (!insideSubmodule(module.source))
        visit({
          ...module,
          imports: module.imports.filter(({ target }) => !insideSubmodule(target)),
        });
    });
  return astro.length
    ? checkAstroImports(root, files, visitLocal)
    : checkImports(new ImportOrigin(root), sources, visitLocal);
}
