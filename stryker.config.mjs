import base from "@hackersandwizards/scaffolding/stryker";

export default {
  ...base,
  mutate: ["lib/rejection.ts"],
  vitest: { ...base.vitest, configFile: "vitest.mutation.config.mjs" },
};
