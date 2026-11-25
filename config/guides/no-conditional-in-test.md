# Branching inside a test body means the test does not fix its own inputs and expected outcomes.

Using `if`, `switch`, `?:`, `&&`, `||`, or `??` in a test or its callbacks leaves paths unexecuted and hides what the test verifies.

Find the fix: build fixtures with known values so the test asserts its result directly. Give every branch of the code under test its own row in `test.each`, pairing input with expected result. When a value may be absent, import `assert` from `vitest` and call `assert(value, "what should be there")` instead of `value ?? ""`. That check fails when missing and narrows the type afterwards. Before a loop or `forEach` over a collection, assert its expected length so an empty collection cannot skip assertions. Compute a test-run setting (such as a timeout factor from the environment) once at module scope or in a support module, then use that value. Break each behaviour once and watch its case fail.

No fix: a fixture covering only the easy branch, moving a condition on test inputs or expected results into a helper, or adding an `else` branch. Replacing `if` or `??` with `?:`, `&&`, or a non-null assertion (`!`) is also no fix.
