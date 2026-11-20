import base from "@hackersandwizards/scaffolding/stryker";

export default {
  ...base,
  ignorePatterns: [...base.ignorePatterns, "!template/.oxlintrc.json"],
  mutate: [
    "lib/astro-spaces.ts",
    "lib/changed-steps.ts",
    "lib/confidential-input.ts",
    "lib/json.ts",
    "lib/licence-expression.ts",
    "lib/lint-disjoint.ts",
    "lib/package-exports.ts",
    "lib/rejection.ts",
    "lib/repo.ts",
    "lib/staged-paths.ts",
    "lib/test-config.ts",
  ],
  vitest: { ...base.vitest, configFile: "vitest.mutation.config.mjs", pool: "forks" },
};
