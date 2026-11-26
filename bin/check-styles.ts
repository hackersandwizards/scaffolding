#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { spawnSync } from "node:child_process";
import { runTrackedLint } from "../lib/extra-lint.ts";
import { pathChunks, styled, stylelintFlags, submodulePaths } from "../lib/repo.ts";

async function lintStyles(root: string, files: string[]) {
  const ignored = submodulePaths(root).flatMap((path) => ["--ignore-pattern", `${path}/**`]);
  return pathChunks(files).reduce((status, chunk) => {
    const run = spawnSync(
      process.execPath,
      ["--bun", "stylelint", ...stylelintFlags(root), ...ignored, "--", ...chunk],
      { cwd: root, stdio: "inherit" },
    );
    if (run.error) throw run.error;
    return status || (run.status ?? 1);
  }, 0);
}

process.exit(
  await runTrackedLint(
    { step: "styles", input: styled, description: "CSS or Astro files" },
    lintStyles,
  ),
);
