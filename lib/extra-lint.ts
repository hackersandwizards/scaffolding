import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { renderGuides } from "./guides.ts";
import { scaffoldingCache } from "./pinned-binary.ts";
import { pathChunks, repoRoot, withoutEnvFile } from "./repo.ts";
import { regularInput, trackedInputs } from "./tracked-inputs.ts";

type LintSpec = {
  step: string;
  input: (path: string) => boolean;
  description: string;
};

export async function runTrackedLint(
  { step, input, description }: LintSpec,
  check: (root: string, files: string[]) => Promise<number>,
) {
  withoutEnvFile(step);
  try {
    const root = realpathSync(repoRoot());
    const files = trackedInputs(root).filter(input);
    if (!files.length) {
      console.log(`[${step}] no tracked ${description}`);
      return 0;
    }
    return await check(root, files);
  } catch (error) {
    console.error(`[${step}] ${(error as Error).message}`);
    return 1;
  }
}

export function lintEnvironment(root: string) {
  const home = scaffoldingCache(root, ["lint-home"], "Lint");
  return {
    PATH: "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    TMPDIR: home,
  };
}

type LintCommand = {
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  finding?: RegExp;
};

function checkedLintExit(binary: string, run: SpawnSyncReturns<string>) {
  if (run.error) throw run.error;
  if (run.status === null)
    throw new Error(`${binary} terminated by ${run.signal ?? "unknown signal"}`);
  return run.status;
}

export function lintCommand(
  { binary, cwd, env, finding }: LintCommand,
  args: string[],
  guide: string,
) {
  const run = spawnSync(binary, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: Infinity,
    stdio: finding ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (run.stdout) process.stdout.write(run.stdout);
  const status = checkedLintExit(binary, run) || Number(finding?.test(run.stdout ?? "") ?? false);
  if (status !== 0) console.log(renderGuides([guide]).trimEnd());
  return status;
}

export function lintChunks(
  command: LintCommand,
  args: string[],
  options: { files: string[]; guide: string },
) {
  return pathChunks(options.files).reduce((status, chunk) => {
    const result = lintCommand(
      command,
      [...args, ...chunk.map((path) => `./${path}`)],
      options.guide,
    );
    return status || result;
  }, 0);
}

export function relativeLintConfig(root: string, names: string[]) {
  const file = names.find((path) => regularInput(root, path));
  return file ? join(root, file) : undefined;
}
