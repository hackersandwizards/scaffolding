import { defineConfig } from "vitest/config";

const timeout = Number(process.env.SCAFFOLDING_TEST_TIMEOUT_MS || 5000);

export default defineConfig({
  test: {
    testTimeout: timeout,
    hookTimeout: timeout,
  },
});
