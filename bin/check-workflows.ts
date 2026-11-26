#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { workflowInput } from "../lib/extra-lint-inputs.ts";
import {
  lintChunks,
  lintEnvironment,
  relativeLintConfig,
  runTrackedLint,
} from "../lib/extra-lint.ts";
import { actionlintPin } from "../lib/pinned-binary-assets.ts";
import { pinnedBinary } from "../lib/pinned-binary.ts";
import { shellcheckBinary } from "../lib/shellcheck.ts";

async function lintWorkflows(root: string, files: string[]) {
  const binary = await pinnedBinary(root, "actionlint", actionlintPin);
  const shellcheck = await shellcheckBinary(root);
  const env = lintEnvironment(root);
  const config = relativeLintConfig(root, [".github/actionlint.yaml", ".github/actionlint.yml"]);
  const args = [
    "-no-color",
    "-pyflakes=",
    `-shellcheck=${shellcheck}`,
    ...(config ? ["-config-file", config] : []),
  ];
  return lintChunks({ binary, cwd: root, env }, args, { files, guide: "actionlint" });
}

process.exit(
  await runTrackedLint(
    { step: "workflows", input: workflowInput, description: "GitHub Actions workflows" },
    lintWorkflows,
  ),
);
