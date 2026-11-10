/** The error `promise` rejects with, as text; fails when it resolves. In place of bun's
 * `expect().rejects`, which waits in a nested event loop: a puppeteer connection shared across tests
 * broke there, and the tests after it failed with "Target closed". */
export const rejection = (promise: Promise<unknown>): Promise<string> => {
  // Made at the call, so the failure's trace names the test's line, not this file alone.
  const resolved = new Error("expected a rejection");
  return promise.then(
    (value) => {
      let shown: string | undefined;
      try {
        shown = JSON.stringify(value);
      } catch {} // a cycle or a BigInt, which JSON refuses
      shown ??= String(value);
      // A rendered page or mail runs to thousands of characters; its start names what resolved.
      if (shown.length > 200) shown = `${shown.slice(0, 200)}… (${shown.length} characters)`;
      resolved.message = `expected a rejection, resolved with ${shown}`;
      throw resolved;
    },
    (e: unknown) => String(e),
  );
};
