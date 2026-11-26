#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
// Astro's default compressHTML, "jsx", drops a line break where text meets an inline tag, so "drawn
// by" on one line and "<code>brand</code>" on the next render as "drawn bybrand". Prettier writes
// {" "} where a space is meant; this finds the line breaks that still carry one. compressHTML true
// and false keep the break as a space, so where every Astro config sets one of them the check reads
// only the components the package ships, which a consumer compiles under its own setting.
import { auditAllow } from "../lib/allow-entries.ts";
import { lostSpaceTag, spaceTemplateLines } from "../lib/astro-spaces.ts";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  commentSyntax,
  exportTargets,
  finish,
  listFiles,
  readPackage,
  repoRoot,
  shippedFiles,
  type Finding,
  type Package,
} from "../lib/repo.ts";

/** The files a consumer can compile: those `bun pm pack` lists, and where package.json has
 * `exports`, only the ones an exported path names and the files they import by a relative path. */
function consumable(root: string, pkg: Package): Set<string> {
  const packed = new Set(shippedFiles(root, pkg, "spaces"));
  if (!pkg.exports) return packed;
  // A * in an exported path matches across folders.
  const exported = exportTargets(pkg.exports).map(
    (t) =>
      new RegExp(
        `^${posix
          .normalize(t)
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replaceAll("*", ".*")}$`,
      ),
  );
  const queue = [...packed].filter((f) => exported.some((e) => e.test(f)));
  const reached = new Set(queue);
  for (const file of queue)
    for (const [, spec] of readFileSync(join(root, file), "utf8").matchAll(
      /(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g,
    )) {
      if (!spec) continue;
      const dep = posix.join(posix.dirname(file), spec);
      if (!packed.has(dep) || reached.has(dep)) continue;
      reached.add(dep);
      queue.push(dep);
    }
  return reached;
}

const started = performance.now();
const root = repoRoot();
const pkg = readPackage(root);
const files = listFiles(root, false);
// The config names Astro looks for.
const configs = files.filter((f) => /(?:^|\/)astro\.config\.m?[jt]s$/.test(f));
const keeps = (config: string) =>
  /\bcompressHTML\s*:\s*(?:false|true)\b/.test(
    readFileSync(join(root, config), "utf8").replace(commentSyntax(config), "$1"),
  );
const kept = configs.length > 0 && configs.every(keeps);
const shipped = kept ? consumable(root, pkg) : new Set<string>();
const reads = (file: string) => !kept || shipped.has(file);
const found: Finding[] = [];
for (const file of files.filter((f) => f.endsWith(".astro") && reads(f))) {
  const lines = spaceTemplateLines(readFileSync(join(root, file), "utf8"));
  lines.forEach((line, i) => {
    const tag = lostSpaceTag(lines, i, kept);
    if (tag)
      found.push({
        check: "spaces",
        path: file,
        text: line.trim(),
        message: `line ${i + 1}: the line break before line ${i + 2} meets <${tag}> and compressHTML "jsx" drops it; end the line in {" "} or join the lines`,
      });
  });
}
finish("spaces", auditAllow(pkg, "spaces", found), started);
