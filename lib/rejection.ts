/** The error `promise` rejects with, as text; fails when it resolves. In place of bun's
 * `expect().rejects`, which waits in a nested event loop: a puppeteer connection shared across tests
 * broke there, and the tests after it failed with "Target closed". */
export const rejection = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    (value) => {
      let shown: string;
      try {
        shown = JSON.stringify(value);
      } catch {
        shown = String(value); // a cycle or a BigInt, which JSON refuses
      }
      throw new Error(`expected a rejection, resolved with ${shown}`);
    },
    (e: unknown) => String(e),
  );
