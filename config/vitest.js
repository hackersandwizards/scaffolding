import { fileURLToPath } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

const timeout = Number(process.env.SCAFFOLDING_TEST_TIMEOUT_MS || 5000);
const underStryker = process.env.STRYKER_MUTATOR_WORKER !== undefined;

export default defineConfig({
  resolve: { preserveSymlinks: underStryker },
  test: {
    server: underStryker ? { deps: { inline: ["@fast-check/vitest"] } } : undefined,
    exclude: [...defaultExclude, "**/.stryker-tmp/**"],
    setupFiles: [fileURLToPath(new URL("./property-setup.js", import.meta.url))],
    testTimeout: timeout,
    hookTimeout: timeout,
    execArgv: underStryker ? ["--preserve-symlinks"] : undefined,
  },
});
