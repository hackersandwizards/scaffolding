import { fc } from "@fast-check/vitest";

const env = typeof process === "undefined" ? {} : process.env;
const underStryker = env.STRYKER_MUTATOR_WORKER !== undefined;
const exploring = !underStryker && env.SCAFFOLDING_EXPLORING === "1";
const seed = exploring ? Number(env.SCAFFOLDING_EXPLORE_SEED) : 17401;
const numRuns = underStryker ? 12 : exploring ? Number(env.SCAFFOLDING_EXPLORE_RUNS) : 64;

if (seed !== (seed | 0) || !Number.isSafeInteger(numRuns) || numRuns < 1)
  throw new Error("Invalid scaffolding property seed or run count");

fc.configureGlobal({ seed, numRuns });

export { fc, test } from "@fast-check/vitest";
