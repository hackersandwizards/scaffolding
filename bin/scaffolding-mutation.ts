#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { fileURLToPath } from "node:url";
import { help } from "../lib/help.ts";
import { runTimed } from "../lib/run-timed.ts";

export function runMutation(command: [string, ...string[]], limitMs = 15 * 60_000) {
  return runTimed(command, {
    name: "scaffolding-mutation",
    limitMs,
    timeoutMessage:
      "Mutation testing reached its 15-minute wall limit. Narrow the run with --mutate <files>.",
  });
}

if (import.meta.main) {
  help("scaffolding-mutation");
  const args = process.argv.slice(2);
  const bunRunner = fileURLToPath(new URL("../lib/stryker-bun.ts", import.meta.url));
  process.exitCode =
    process.env.SCAFFOLDING_MUTATION_BUN === "1"
      ? await runMutation([process.execPath, "--no-env-file", bunRunner, ...args])
      : await runMutation(["stryker", "run", ...args]);
}
