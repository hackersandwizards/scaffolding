# This `expect` runs only on some branches and does not execute when the condition is false.

An assertion inside `if`, `switch`, a ternary, a logical expression, or `catch` lets a test pass unchecked whenever that branch does not run.

Find the fix: assert both the condition and the guarded behaviour unconditionally. When filtering items, select them first, assert the selection's exact length or contents so a missing item fails the test, then assert on each item. When testing multiple branches, write one row per branch with `test.each`. For a synchronous error, use `expect(...).toThrow(...)`. For a rejected promise, call `await rejection(promise)` from `@hackersandwizards/scaffolding/rejection` and assert on the error text it returns. Verify the test by breaking the behaviour named in the title once and watching the test fail.

No fix: adding an `else` branch with a dummy assertion, or moving the conditional `expect` into a helper. Dropping the guarded assertion, or capturing an error in `catch` to assert on a variable outside it, is also no fix.
