# This `catch` block or `.catch()` callback discards every error it receives.

A comment-only `catch` block or an empty promise `.catch(() => {})` hides both expected failures and real bugs.

Find the fix: run each affected environment to see which errors reach the catch. Decide any fallback with a check before the call. In pre-paint scripts, set defaults first and guard only the optional step. When the API can only signal the expected failure by throwing, keep the try around that call and match its code, name, or class. Handle that error and rethrow every other one. Remove a handler that has no expected error to handle. Test the propagating error in each affected environment, including the browser for inline scripts.

No fix: a longer comment, a no-op (`void error`), or `instanceof Error`. Logging and continuing where no contract accepts the failure, or returning a blanket fallback such as `.catch(() => undefined)`, is also no fix.
