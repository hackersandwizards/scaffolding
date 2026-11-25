# This `expect` call has no matcher, wrong arguments, or an unawaited promise assertion.

Chain a matcher stating the expected value from the specification or fixture, never copied from current output, and `await` or return promise assertions. A second argument to `expect` prints on failure. The linter's help line suggests `toBeDefined()`, which does not fix it.

No fix: any matcher that passes for a wrong result, such as `toBeDefined()`, `toBeTruthy()`, or `.toBe(result)`.
