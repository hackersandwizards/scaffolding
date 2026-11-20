import { fc, test as vitestTest } from "@fast-check/vitest";

const env = typeof process === "undefined" ? {} : process.env;
const underStryker = env.STRYKER_MUTATOR_WORKER !== undefined;
const exploring = !underStryker && env.SCAFFOLDING_EXPLORING === "1";
const marker = exploring ? env.SCAFFOLDING_EXPLORE_MARKER : undefined;
const seed = exploring ? Number(env.SCAFFOLDING_EXPLORE_SEED) : 17401;
const numRuns = underStryker ? 12 : exploring ? Number(env.SCAFFOLDING_EXPLORE_RUNS) : 64;

if (seed !== (seed | 0) || !Number.isSafeInteger(numRuns) || numRuns < 1)
  throw new Error("Invalid scaffolding property seed or run count");

fc.configureGlobal({ seed, numRuns });

export const unicodeString = fc.string({ unit: "grapheme", maxLength: 1024, size: "max" });

export const test = marker
  ? new Proxy(vitestTest, {
      get(target, key, receiver) {
        if (key !== "prop") return Reflect.get(target, key, receiver);
        return (arbitraries, options) => {
          const register = target.prop(arbitraries, options);
          return (name, callback, timeout) => register(`[${marker}] ${name}`, callback, timeout);
        };
      },
    })
  : vitestTest;

export { fc };
