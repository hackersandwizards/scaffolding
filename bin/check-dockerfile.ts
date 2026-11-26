#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { dockerfileInput } from "../lib/extra-lint-inputs.ts";
import {
  lintChunks,
  lintEnvironment,
  relativeLintConfig,
  runTrackedLint,
} from "../lib/extra-lint.ts";
import { hadolintPin } from "../lib/pinned-binary-assets.ts";
import { pinnedBinary } from "../lib/pinned-binary.ts";

async function lintDockerfiles(root: string, files: string[]) {
  const binary = await pinnedBinary(root, "hadolint", hadolintPin);
  const env = lintEnvironment(root);
  const config = relativeLintConfig(root, [".hadolint.yaml", ".hadolint.yml"]);
  const args = [
    "--no-color",
    "--format",
    "tty",
    "--failure-threshold",
    "ignore",
    ...(config ? ["--config", config] : []),
  ];
  return lintChunks(
    { binary, cwd: root, env, finding: /:\d+ (?:DL|SC)\d{4} \w+: |:\d+:\d+: / },
    args,
    { files, guide: "hadolint" },
  );
}

process.exit(
  await runTrackedLint(
    { step: "dockerfile", input: dockerfileInput, description: "Dockerfiles" },
    lintDockerfiles,
  ),
);
