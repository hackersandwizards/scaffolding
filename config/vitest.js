import { defaultExclude, defineConfig } from "vitest/config";

const timeout = Number(process.env.SCAFFOLDING_TEST_TIMEOUT_MS || 5000);
const underStryker = process.env.STRYKER_MUTATOR_WORKER !== undefined;

export default defineConfig({
  resolve: { preserveSymlinks: underStryker },
  test: {
    exclude: [...defaultExclude, "**/.stryker-tmp/**"],
    testTimeout: timeout,
    hookTimeout: timeout,
    execArgv: underStryker ? ["--preserve-symlinks"] : undefined,
  },
});
