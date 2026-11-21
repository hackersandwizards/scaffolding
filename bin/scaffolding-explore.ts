#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { ownEntry } from "../lib/json.ts";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import vitest from "vitest/package.json";
import { help } from "../lib/help.ts";
import { readPackage, withoutEnvFile } from "../lib/repo.ts";
import { runTimed } from "../lib/run-timed.ts";

help("scaffolding-explore");
const context =
  process.env.CI !== undefined
    ? "CI"
    : process.env.SCAFFOLDING_GIT_HOOK !== undefined || process.env.GIT_INDEX_FILE !== undefined
      ? "a git hook"
      : process.env.SCAFFOLDING_CHANGED !== undefined
        ? "the gate"
        : undefined;
if (context) {
  console.error(`[scaffolding-explore] cannot run inside ${context}`);
  process.exit(2);
}

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

withoutEnvFile("scaffolding-explore");
const pkg = readPackage(process.cwd());
const test = pkg.scaffolding?.test ?? "test";
const command = ownEntry(pkg.scripts, test) ?? test;
const runtime = /^\s*bun\s+--bun\s+(?:run\s+)?vitest(?:\s|$)/.test(command)
  ? process.execPath
  : "node";
const cli = fileURLToPath(new URL(vitest.bin.vitest, import.meta.resolve("vitest/package.json")));
const marker = randomBytes(16).toString("hex");
const argsForTest = [
  "--coverage.enabled=false",
  "--exclude",
  "**/!(*.prop.test).{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
  "--testNamePattern",
  `\\[${marker}\\] `,
  ".prop.test.",
];
const runs = 512;
const limitMs = 120_000;
const timeout = Number(process.env.SCAFFOLDING_TEST_TIMEOUT_MS || 5000);
console.log(`[scaffolding-explore] seed ${seed}, ${runs} runs per property`);
process.exitCode = await runTimed([runtime, cli, "run", ...argsForTest], {
  name: "scaffolding-explore",
  limitMs,
  timeoutMessage: `[scaffolding-explore] reached the 2-minute wall limit (seed ${seed})`,
  env: {
    ...process.env,
    STRYKER_MUTATOR_WORKER: undefined,
    SCAFFOLDING_EXPLORING: "1",
    SCAFFOLDING_EXPLORE_MARKER: marker,
    SCAFFOLDING_EXPLORE_SEED: String(seed),
    SCAFFOLDING_EXPLORE_RUNS: String(runs),
    SCAFFOLDING_TEST_TIMEOUT_MS: String(Math.min(timeout * 8, limitMs)),
  },
});
