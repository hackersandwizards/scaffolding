# This `catch` block only rethrows the caught error unchanged.

Check whether this block adds useful context or has a `finally`. Remove `try`/`catch` (keeping `finally` if present) when no context belongs here. Otherwise throw a new error whose message states what the code was doing when it failed, with `{ cause: error }`.

No fix: logging and rethrowing, or wrapping the error with the same original message.
