import base from "@hackersandwizards/scaffolding/stryker";

export default {
  ...base,
  ignorePatterns: [...base.ignorePatterns, "!template/.oxlintrc.json"],
  incremental: false,
  mutate: [
    "lib/astro-spaces.ts",
    "lib/changed-steps.ts",
    "lib/confidential-input.ts",
    "lib/json.ts",
    "lib/licence-expression.ts",
    "lib/lint-rule-overlaps.ts",
    "lib/package-exports.ts",
    "lib/rejection.js",
    "lib/repo-inputs.ts",
    "lib/staged-paths.ts",
  ],
  vitest: { ...base.vitest, configFile: "vitest.mutation.config.mjs", pool: "forks" },
};
