# This `expect` call has invalid arguments, no matcher, or an unawaited async assertion.

Pass a value, chain a matcher stating the expected value, and `await` or return async assertions. A second argument to `expect` is the message printed when the assertion fails. Break the behaviour once to confirm it fails.

No fix: a matcher passing for nearly any value, such as `toBeDefined()` (despite the help line) or `toBeTruthy()`.
