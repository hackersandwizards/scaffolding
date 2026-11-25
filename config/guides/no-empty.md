# This block contains no statements, leaving a discarded error or an unused branch.

An empty `catch` discards failures without showing whether ignoring them is intentional. An empty `if`, `else`, loop, or `finally` leaves unfinished logic in the control flow.

Find the fix: for an expected error in `catch`, match its specific error code, return the explicit fallback value, and rethrow all other errors. For an unexpected error, remove the `try`/`catch` so the failure propagates. At the edge of the program, where errors reach the user or log, throw a new error stating what failed with the original as `cause`. For an empty `if`, `else`, loop, or `finally`, write the missing statements or remove the branch until no block is empty.

No fix: adding a comment inside the block, even though the linter's help line suggests it. Writing a no-op such as `void error` or a bare semicolon is also no fix. Do not log and continue, or catch every error to return `null`, `undefined`, or any blanket fallback.
