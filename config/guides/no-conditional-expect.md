# This `expect` runs only on some branches and skips when the condition is false.

An assertion inside `if`, `switch`, `?:`, `&&`, `||`, or `catch` passes unchecked when that branch skips.

Find the fix: assert the guarded behaviour unconditionally, or use `test.each` for multiple branches. When filtering output from the code under test, assert the filtered list's exact contents so a missing item fails. For a literal list written in the test, skip length checks (they cannot fail) and use `test.each`. When sweeping data you do not own (such as a content folder), put the rule in a function returning violations. Test it on an inline fixture with one reported item and one clean item, then assert no violations on real data. For errors, use `toThrow(...)`, or `await rejection(promise)` from `@hackersandwizards/scaffolding/rejection`, which fails if the promise resolves, and assert the returned text. Break the behaviour once to confirm the test fails.

No fix: `if (!condition) return;` ahead of `expect`, or hiding the condition in a helper, `else`, or `expect(cond && value)`. Pinning a fact about one real record, or asserting outside `catch` on a caught error, is also no fix.
