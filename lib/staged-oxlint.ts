import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { oxlintConfig, oxlintExtends, parseOxlintConfig, runOxlintWithGuides } from "./oxlint.ts";
import { isObject, pathChunks } from "./repo.ts";

export function prepareStagedOxlintConfig(rawConfig: string): string {
  const config = parseOxlintConfig(rawConfig);
  if (!isObject(config.options) || config.options.typeAware !== true)
    throw new Error(
      `${oxlintConfig}: options.typeAware must be true — set "options": { "typeAware": true } in ${oxlintConfig} and stage it; do not turn type-aware linting off`,
    );
  config.options = { ...config.options, typeAware: false, typeCheck: false };
  return JSON.stringify(config);
}

export function stagedOxlintInputs(baseExtends: string, oxlintPaths: readonly string[]): string[] {
  const inputs = [oxlintConfig, ...oxlintPaths];
  if (!baseExtends.startsWith("./node_modules/")) inputs.push(baseExtends.slice(2));
  return inputs;
}

export function runStagedOxlint(root: string, oxlintPaths: readonly string[]): number {
  const inputs = stagedOxlintInputs(oxlintExtends(root), oxlintPaths);
  const cache = join(root, "node_modules/.cache/scaffolding");
  mkdirSync(cache, { recursive: true });
  const snapshot = mkdtempSync(join(cache, "staged-oxlint-"));
  let code = 0;
  try {
    const checkout = spawnSync(
      "git",
      ["checkout-index", "-z", "--stdin", `--prefix=${snapshot}/`],
      {
        cwd: root,
        input: inputs.join("\0") + "\0",
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    if (checkout.status !== 0) throw new Error("could not check out the staged oxlint inputs");
    const configPath = join(snapshot, oxlintConfig);
    if (!lstatSync(configPath).isFile())
      throw new Error(
        `${oxlintConfig} must be a regular file: replace the symlink or directory at ${oxlintConfig} with the repository's regular file (run \`check-structure --fix\` to restore the template) and stage it`,
      );
    writeFileSync(configPath, prepareStagedOxlintConfig(readFileSync(configPath, "utf8")));
    symlinkSync(join(root, "node_modules"), join(snapshot, "node_modules"), "dir");
    for (const paths of pathChunks([...oxlintPaths])) {
      code = runOxlintWithGuides(snapshot, [
        "--no-ignore",
        "--no-error-on-unmatched-pattern",
        "--",
        ...paths,
      ]);
      if (code) break;
    }
  } catch (error) {
    code = 1;
    console.error(`[check:staged] oxlint: ${(error as Error).message}`);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
  return code;
}
