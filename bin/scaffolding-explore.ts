#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { randomBytes } from "node:crypto";
import { help } from "../lib/help.ts";
import { runTimed } from "../lib/run-timed.ts";

help("scaffolding-explore");
const args = process.argv.slice(2);
const seed = args.length ? Number(args[1]) : randomBytes(4).readInt32LE();
if (
  args.length &&
  (args.length !== 2 ||
    args[0] !== "--seed" ||
    !/^-?\d+$/.test(args[1] ?? "") ||
    seed !== (seed | 0))
) {
  console.error("usage: scaffolding-explore [--seed <signed-32-bit integer>]");
  process.exit(2);
}

const runs = 512;
console.log(`[scaffolding-explore] seed ${seed}, ${runs} runs per property`);
process.exitCode = await runTimed(
  [
    process.execPath,
    "--no-env-file",
    "--bun",
    "vitest",
    "run",
    "--exclude",
    "**/!(*.prop.test).{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
    ".prop.test.",
  ],
  {
    name: "scaffolding-explore",
    limitMs: 120_000,
    timeoutMessage: `[scaffolding-explore] reached the 2-minute wall limit (seed ${seed})`,
    env: {
      ...process.env,
      STRYKER_MUTATOR_WORKER: undefined,
      SCAFFOLDING_EXPLORE_SEED: String(seed),
      SCAFFOLDING_EXPLORE_RUNS: String(runs),
    },
  },
);
