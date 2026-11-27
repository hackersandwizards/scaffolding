export const limit = (ms: number) =>
  (ms * Number(process.env.SCAFFOLDING_TEST_TIMEOUT_MS || 5000)) / 5000;
