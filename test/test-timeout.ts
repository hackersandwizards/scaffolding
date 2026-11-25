// A test's own limit stretches with load as the runner's default does: the gate sets
// SCAFFOLDING_TEST_TIMEOUT_MS from the machine's load, 5000 on an idle machine.
export const limit = (ms: number) =>
  (ms * Number(process.env.SCAFFOLDING_TEST_TIMEOUT_MS || 5000)) / 5000;
