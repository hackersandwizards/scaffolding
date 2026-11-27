import { transform } from "@astrojs/compiler-rs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { knipStylesheetCompiler } from "./knip-audit.ts";

const packageName = /^(@[\w.-]+\/[\w.-]+|[\w][\w.-]*)(?:\/|$)/;

function astroStyleBlocks(source: string, filename: string) {
  return source.includes("<style") ? transform(source, { filename }).css : [];
}

export async function unusedStyleDependencies(root: string, files: string[]) {
  const { default: compile } = await knipStylesheetCompiler();
  const scanner = new Bun.Transpiler({ loader: "js" });
  const used = new Map<string, Set<string>>();
  for (const path of files) {
    if (!/\.(?:css|astro)$/.test(path)) continue;
    const source = readFileSync(join(root, path), "utf8");
    const blocks = path.endsWith(".css") ? [source] : astroStyleBlocks(source, path);
    for (const { path: specifier } of scanner.scanImports(compile(blocks.join("\n")))) {
      const name = packageName.exec(specifier)?.[1];
      if (!name) continue;
      const paths = used.get(name) ?? new Set<string>();
      paths.add(join(root, path));
      used.set(name, paths);
    }
  }
  return used;
}
