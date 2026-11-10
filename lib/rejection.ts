/** The error `promise` rejects with, as text; fails when it resolves. In place of bun's
 * `expect().rejects`, which waits in a nested event loop: a puppeteer connection shared across tests
 * broke there, and the tests after it failed with "Target closed". */
export const rejection = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    (value) => {
      throw new Error(`expected a rejection, resolved with ${JSON.stringify(value)}`);
    },
    (e: unknown) => String(e),
  );
