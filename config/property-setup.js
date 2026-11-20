import { fc } from "./property.js";

const underStryker = process.env.STRYKER_MUTATOR_WORKER !== undefined;
const exploring = !underStryker && process.env.SCAFFOLDING_EXPLORE_SEED !== undefined;
const seed = exploring ? Number(process.env.SCAFFOLDING_EXPLORE_SEED) : 17401;
const numRuns = underStryker ? 12 : exploring ? Number(process.env.SCAFFOLDING_EXPLORE_RUNS) : 64;

if (seed !== (seed | 0) || !Number.isSafeInteger(numRuns) || numRuns < 1)
  throw new Error("Invalid scaffolding property seed or run count");

fc.configureGlobal({ seed, numRuns });
