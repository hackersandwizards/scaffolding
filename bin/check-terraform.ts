#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { basename, dirname, join, relative } from "node:path";
import { terraformInput } from "../lib/extra-lint-inputs.ts";
import {
  lintChunks,
  lintCommand,
  lintEnvironment,
  relativeLintConfig,
  runTrackedLint,
} from "../lib/extra-lint.ts";
import { terraformPin, tflintPin } from "../lib/pinned-binary-assets.ts";
import { pinnedBinary, scaffoldingCache } from "../lib/pinned-binary.ts";

async function terraformFormat(root: string, files: string[], fix: boolean) {
  const binary = await pinnedBinary(root, "terraform", terraformPin);
  const env = { ...lintEnvironment(root), CHECKPOINT_DISABLE: "1" };
  const flags = fix ? ["fmt"] : ["fmt", "-check", "-diff", "-no-color"];
  return lintChunks({ binary, cwd: root, env }, flags, { files, guide: "terraform-fmt" });
}

function terraformDirectories(files: string[]) {
  const directories = new Map<string, string[]>();
  for (const file of files) {
    if (!file.endsWith(".tf")) continue;
    const dir = dirname(file);
    const filter = basename(file).replace(/[\\*?[\]]/g, "\\$&");
    const entry = directories.get(dir) ?? [];
    entry.push(`--filter=${filter}`);
    directories.set(dir, entry);
  }
  return directories;
}

async function terraformLint(root: string, files: string[]) {
  const directories = terraformDirectories(files);
  if (!directories.size) return 0;
  const binary = await pinnedBinary(root, "tflint", tflintPin);
  const env = {
    ...lintEnvironment(root),
    TFLINT_PLUGIN_DIR: scaffoldingCache(root, ["tflint-plugins"], "TFLint"),
  };
  const config = relativeLintConfig(root, [".tflint.hcl"]);
  const configFlags = [`--config=${config ?? "/dev/null"}`];
  if (config) {
    const init = lintCommand({ binary, cwd: root, env }, ["--init", ...configFlags], "tflint");
    if (init) return init;
  }
  let status = 0;
  for (const [dir, filters] of directories) {
    const cwd = join(root, dir);
    // The bundled ruleset uses a Unix socket, whose path can exceed the platform limit.
    const pluginEnv = { ...env, TMPDIR: relative(cwd, env.TMPDIR) };
    const result = lintCommand(
      { binary, cwd, env: pluginEnv, finding: /^\d+ issue\(s\) found:/m },
      [
        ...configFlags,
        "--no-color",
        "--format=compact",
        "--minimum-failure-severity=notice",
        ...filters,
      ],
      "tflint",
    );
    status ||= result;
  }
  return status;
}

async function checkTerraform(root: string, files: string[]) {
  const fix = process.argv[2] === "--fix";
  const format = await terraformFormat(root, files, fix);
  const lint = fix ? 0 : await terraformLint(root, files);
  return format || lint;
}

process.exit(
  await runTrackedLint(
    { step: "terraform", input: terraformInput, description: "Terraform files" },
    checkTerraform,
  ),
);
