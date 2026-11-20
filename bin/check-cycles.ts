#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { existsSync } from "node:fs";
import { join } from "node:path";
import { allExtensions, cruise } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import { finish, listFiles, repoRoot, submodulePaths, type Finding } from "../lib/repo.ts";

const started = performance.now();
const root = repoRoot();
const check = "cycles";
const stop = (message: string): never =>
  finish(check, [{ check, path: "package.json", text: "", message }], started);

const submodules = submodulePaths(root);
const files = listFiles(root, false).filter(
  (path) => /\.[cm]?[jt]sx?$/.test(path) && !submodules.some((s) => path.startsWith(`${s}/`)),
);
if (files.length === 0) finish(check, [], started);
// Fail closed: without a TypeScript compiler it can load, dependency-cruiser reads no .ts file and
// reports no cycle among them.
if (
  files.some((path) => /\.[cm]?tsx?$/.test(path)) &&
  !allExtensions.some((e) => e.extension === ".ts" && e.available)
)
  stop("dependency-cruiser cannot read TypeScript here: run bun install");

// The tsconfig carries the path aliases; without it an aliased import resolves to nothing and a
// cycle through it passes.
const tsconfig = join(root, "tsconfig.json");
const aliases = existsSync(tsconfig);
const cruised = await cruise(
  files,
  {
    baseDir: root,
    validate: true,
    tsPreCompilationDeps: false,
    doNotFollow: { path: "node_modules" },
    ...(aliases ? { tsConfig: { fileName: tsconfig } } : {}),
    ruleSet: {
      forbidden: [{ name: check, severity: "error", from: {}, to: { circular: true } }],
    },
  },
  undefined,
  aliases ? { tsConfig: extractTSConfig(tsconfig) } : undefined,
);
const result = cruised.output;
if (typeof result === "string") stop("dependency-cruiser returned no result");
else {
  if (result.summary.totalCruised === 0) stop(`none of ${files.length} files was read`);
  // Every module on a cycle reports it once: keep one finding per set of modules.
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const violation of result.summary.violations) {
    const cycle = (violation.cycle ?? []).map((step) => step.name);
    const key = [...cycle].sort().join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      check,
      path: violation.from,
      text: [violation.from, ...cycle].join(" -> "),
      message:
        "runtime import cycle: move what both sides need into a module neither imports back from, or import the type with `import type`",
    });
  }
  finish(check, findings, started);
}
