#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { help } from "../lib/help.ts";
import { runTimed } from "../lib/run-timed.ts";

export function runMutation(
  command: [string, ...string[]],
  limitMs = 15 * 60_000,
  env?: NodeJS.ProcessEnv,
) {
  return runTimed(command, {
    name: "scaffolding-mutation",
    limitMs,
    env,
    timeoutMessage:
      "Mutation testing reached its 15-minute wall limit. Narrow the run with --mutate <files>.",
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (process.env.SCAFFOLDING_MUTATION_WORKER === "1") {
    // The Vitest runner must load Vite before Stryker installs its stack-trace hook on Bun.
    await import("@stryker-mutator/vitest-runner");
    const { StrykerCli } = await import("@stryker-mutator/core");
    process.title = "stryker";
    new StrykerCli([process.execPath, "stryker", "run", ...args]).run();
  } else {
    help("scaffolding-mutation");
    process.exitCode =
      process.env.SCAFFOLDING_MUTATION_BUN === "1"
        ? await runMutation(
            [process.execPath, "--no-env-file", import.meta.path, ...args],
            undefined,
            {
              ...process.env,
              SCAFFOLDING_MUTATION_WORKER: "1",
            },
          )
        : await runMutation(["stryker", "run", ...args]);
  }
}
