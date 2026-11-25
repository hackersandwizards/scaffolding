# This test executes code without asserting any outcome, so it passes even when the code fails.

A test with no assertion verifies only that execution finished without an uncaught error, leaving the claimed behaviour untested.

Find the fix: read the test title and add an `expect` call that checks the behaviour it describes. Use `expect(() => run()).not.toThrow()` only when the tested behaviour itself is that a throwing call succeeds. Where code dispatches a user-interface event, the framework catches errors thrown by handlers, so assert what the event changed instead. If real assertions already run inside a helper, name it with an `expect` or `assert` prefix so the check recognises it. Confirm the test is real: break the behaviour named in the title once and watch the test fail.

No fix: `not.toThrow()` around a call that cannot throw (such as dispatching a UI event), `expect(true).toBe(true)`, or `toBeDefined()` on an always-defined value. Weakening the title to a smoke check, prefixing a non-asserting helper with `expect`, or deleting a test whose behaviour still exists is also no fix.
