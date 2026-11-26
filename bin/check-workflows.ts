#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflowInput } from "../lib/extra-lint-inputs.ts";
import {
  lintChunks,
  lintEnvironment,
  relativeLintConfig,
  runTrackedLint,
} from "../lib/extra-lint.ts";
import { isObject } from "../lib/json.ts";
import { actionlintPin } from "../lib/pinned-binary-assets.ts";
import { pinnedBinary, scaffoldingCache } from "../lib/pinned-binary.ts";
import { shellcheckBinary } from "../lib/shellcheck.ts";

// GitHub-hosted images missing from actionlint v1.7.12: https://github.com/actions/runner-images#available-images
const additionalRunnerLabels = ["ubuntu-26.04", "ubuntu-26.04-arm"];

function mergedActionlintConfig(root: string) {
  const file = relativeLintConfig(root, [".github/actionlint.yaml", ".github/actionlint.yml"]);
  const config: unknown = (file && Bun.YAML.parse(readFileSync(file, "utf8"))) ?? {};
  if (!isObject(config)) throw new Error(`${file}: expected an actionlint config mapping`);
  const runners = config["self-hosted-runner"] ?? {};
  if (!isObject(runners)) throw new Error(`${file}: self-hosted-runner must be a mapping`);
  const labels = runners.labels ?? [];
  if (!Array.isArray(labels)) throw new Error(`${file}: self-hosted-runner.labels must be a list`);
  const existingLabels: unknown[] = labels;
  return {
    ...config,
    "self-hosted-runner": {
      ...runners,
      labels: [...new Set([...existingLabels, ...additionalRunnerLabels])],
    },
  };
}

async function lintWorkflows(root: string, files: string[]) {
  const binary = await pinnedBinary(root, "actionlint", actionlintPin);
  const shellcheck = await shellcheckBinary(root);
  const env = lintEnvironment(root);
  const cache = scaffoldingCache(root, [], "Actionlint");
  const config = join(cache, `actionlint-${randomUUID()}.json`);
  writeFileSync(config, JSON.stringify(mergedActionlintConfig(root)), { flag: "wx", mode: 0o600 });
  try {
    const args = ["-no-color", "-pyflakes=", `-shellcheck=${shellcheck}`, "-config-file", config];
    return lintChunks({ binary, cwd: root, env }, args, { files, guide: "actionlint" });
  } finally {
    unlinkSync(config);
  }
}

process.exit(
  await runTrackedLint(
    { step: "workflows", input: workflowInput, description: "GitHub Actions workflows" },
    lintWorkflows,
  ),
);
