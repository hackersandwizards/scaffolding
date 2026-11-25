# This test uses an empty test body or `expect(...).resolves`/`.rejects`, which skips verification or breaks under Bun.

Find the fix: follow the part that matches the message on the finding line.

- Empty test body: write an assertion checking the behaviour named in the title, and confirm it fails when you break that behaviour once. Delete the test only after checking the code under test to confirm the behaviour was removed.
- `expect(...).resolves` or `.rejects`: under Bun the test runner waits for these in a way that broke a browser connection shared across a file's tests. For a resolving promise, `await` it and assert on the value. For a rejecting promise, call `await rejection(promise)` from `@hackersandwizards/scaffolding/rejection` and assert on the error text it returns.

No fix: a comment-only body, or any assertion that passes whatever the code returns, such as `expect(true).toBe(true)`, `toBeDefined()`, or `toBeTruthy()` on an always-truthy value. Narrowing the title to an easier check, or deleting a test whose behaviour still exists, is also no fix.
