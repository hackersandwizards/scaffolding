# This `catch` block or `.catch()` callback discards every error it receives.

A comment-only `catch` block or an empty promise `.catch(() => {})` hides both expected failures and real bugs.

Find the fix: before narrowing a `catch`, run the code in every environment (browser, server, test) to list absorbed errors. A rethrown error ends code after it, so in a pre-paint script set the default first and guard only the optional step. Where `try` wraps one call throwing only the expected error (`JSON.parse`), shrink `try` to it and return the fallback without a check. When `try` can fail in several ways, match by `error.code` (`"ENOENT"`), `error.name` (`"QuotaExceededError"`), or a library class with `instanceof`. Return the fallback and rethrow other errors, or rethrow other errors without returning when the call has no result. Remove `try`/`catch` or `.catch()` for unexpected errors. Where the program reports errors to its user or log, throw a new error stating what was running with `cause`. Bundle inline scripts to import shared checks, or keep one shared inline script. Test the propagating error (using a browser test for inline scripts).

No fix: a longer comment, a no-op such as `void error`, or `instanceof Error`. Logging and continuing, or returning a blanket fallback such as `.catch(() => undefined)`, is also no fix.
