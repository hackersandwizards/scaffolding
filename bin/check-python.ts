#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pythonInput } from "../lib/extra-lint-inputs.ts";
import {
  lintChunks,
  lintEnvironment,
  relativeLintConfig,
  runTrackedLint,
} from "../lib/extra-lint.ts";
import { ruffPin } from "../lib/pinned-binary-assets.ts";
import { pinnedBinary, scaffoldingCache } from "../lib/pinned-binary.ts";
import { regularInput, trackedInputs } from "../lib/tracked-inputs.ts";

function ruffTargetVersion(requiresPython: unknown) {
  if (typeof requiresPython !== "string") return "py39";
  let minor = -1;
  for (const [, bound] of requiresPython.matchAll(/(?:^|,)\s*(?:>=?|~=|==)\s*3\.(\d+)\b/g)) {
    minor = Math.max(minor, Number(bound));
  }
  return minor < 0 ? "py39" : `py3${minor}`;
}

function ruffConfig(root: string) {
  const standalone = relativeLintConfig(root, [".ruff.toml", "ruff.toml"]);
  if (standalone) return ["--config", standalone];
  const pyproject = join(root, "pyproject.toml");
  let requiresPython: unknown;
  if (regularInput(root, "pyproject.toml")) {
    const parsed = Bun.TOML.parse(readFileSync(pyproject, "utf8")) as {
      tool?: { ruff?: unknown };
      project?: { "requires-python"?: unknown };
    };
    if (parsed.tool?.ruff !== undefined) return ["--config", pyproject];
    if (trackedInputs(root, "pyproject.toml").length) {
      requiresPython = parsed.project?.["requires-python"];
    }
  }
  return ["--isolated", "--target-version", ruffTargetVersion(requiresPython)];
}

async function lintPython(root: string, files: string[]) {
  const config = ruffConfig(root);
  const binary = await pinnedBinary(root, "ruff", ruffPin);
  const env = lintEnvironment(root);
  const flags = [
    ...config,
    "--force-exclude",
    "--cache-dir",
    scaffoldingCache(root, ["ruff-cache"], "Ruff"),
  ];
  const fix = process.argv[2] === "--fix";
  const command = { binary, cwd: root, env };
  const lint = lintChunks(
    command,
    [
      "check",
      "--output-format",
      "concise",
      "--no-fix-only",
      fix ? "--fix" : "--no-fix",
      ...flags,
      "--",
    ],
    { files, guide: "ruff" },
  );
  const format = lintChunks(command, ["format", ...(fix ? [] : ["--check"]), ...flags, "--"], {
    files,
    guide: "ruff",
  });
  return lint || format;
}

process.exit(
  await runTrackedLint(
    { step: "python", input: pythonInput, description: "Python files" },
    lintPython,
  ),
);
