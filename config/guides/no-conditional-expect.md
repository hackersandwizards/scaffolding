# This `expect` runs only on some branches and skips when the condition is false.

An assertion inside `if`, `switch`, `?:`, `&&`, `||`, or `catch` passes unchecked when that branch skips.

Find the fix: assert the guarded behaviour unconditionally, or use `test.each` for branches. When a selection is empty or a condition is never true, the assertion never ran. Add that case to the fixture if needed, or delete the dead branch after checking the code. When filtering output from the code, assert the exact contents so a missing item fails. For a literal test list, skip length checks and use `test.each`. When sweeping external data (such as content folders), put the rule in a function returning violations. Test it on an inline fixture (one reported, one clean), then assert no violations on real data. For errors, use `toThrow(...)`, or `await rejection(promise)` from `@hackersandwizards/scaffolding/rejection` (which fails if it resolves) and assert the text. Break the behaviour once to confirm failure.

No fix: `if (!condition) return;` ahead of `expect`, or hiding the condition in a helper, `else`, or `expect(cond && value)`. Pinning a fact about one real record, or asserting outside `catch` on a caught error, is also no fix.
