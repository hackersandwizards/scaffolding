import base from "@hackersandwizards/scaffolding/stryker";

export default {
  ...base,
  ignorePatterns: [...base.ignorePatterns, "!template/.oxlintrc.json"],
  mutate: [
    "lib/astro-spaces.ts:44-67",
    "lib/changed-steps.ts",
    "lib/confidential-input.ts",
    "lib/json.ts",
    "lib/licence-expression.ts",
    "lib/lint-disjoint.ts:36-50",
    "lib/lint-disjoint.ts:56-75",
    "lib/lint-disjoint.ts:134-153",
    "lib/package-exports.ts",
    "lib/rejection.ts",
    "lib/repo.ts:12-21",
    "lib/repo.ts:136-159",
    "lib/repo.ts:185-189",
    "lib/staged-paths.ts",
  ],
  vitest: { ...base.vitest, configFile: "vitest.mutation.config.mjs", pool: "forks" },
};
