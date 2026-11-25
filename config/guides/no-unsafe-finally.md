# A `return`, `throw`, `break`, or `continue` in `finally` overrides any result or error from `try` and `catch`.

Move the control-flow statement into `try` or `catch`, and handle cleanup errors explicitly so `finally` runs only cleanup and never discards the outcome.

No fix: calling a helper from `finally` that throws, or placing an unconditional `return` right after `try` so it still overrides the result.
