# This test executes code without asserting any outcome, so it passes even when the code fails.

A test with no assertion verifies only that execution finished without an uncaught error, leaving the claimed behaviour untested.

Find the fix: read the test title and add an `expect` call that checks the behaviour it describes. Use `expect(() => run()).not.toThrow()` only when the tested behaviour itself is that the call succeeds without throwing. If real assertions already run inside a helper, name that helper with an `expect` or `assert` prefix so the check recognises it. Confirm the test is real: break the behaviour named in the title on purpose once and watch the test fail.

No fix: adding `expect(true).toBe(true)`, using `toBeDefined()` on an always-defined value, weakening the title to a smoke check, or prefixing a non-asserting helper with `expect`. Deleting the test is no fix while the behaviour still exists in the code under test.
