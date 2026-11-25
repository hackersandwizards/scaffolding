# This test executes code without asserting any outcome, so it passes even when the code fails.

A test with no assertion verifies only that execution finished without an uncaught error, leaving the claimed behaviour untested.

Find the fix: read the test title and add an `expect` call checking that behaviour (or `expectTypeOf` for a compile-time type test). Use `expect(() => run()).not.toThrow()` only when the tested behaviour is that a throwing call succeeds. Where code dispatches a UI event, the framework catches handler errors, so assert what the event changed instead. A helper containing assertions, or waiting for a condition and throwing when unmet (such as a page probe), is an assertion. Name it with an `expect` or `assert` prefix so the check recognises it, or write `waitFor(() => expect(...))`. Break the title's behaviour once and watch the test fail.

No fix: `not.toThrow()` on a non-throwing call (such as a UI event), `expect(true).toBe(true)`, or `toBeDefined()` on an always-defined value. Adding `expect` calls that only restate a probe, weakening the title, prefixing a non-asserting helper, or deleting a valid test is also no fix.
