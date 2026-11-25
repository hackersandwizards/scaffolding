# The `Function` type accepts any call signature and disables parameter and return checking.

Replace `Function` with the exact function signature callers and tests expect, such as `(arg: A) => R`, so TypeScript checks every call.

No fix: writing `(...args: any[]) => any`, or using `(...args: unknown[]) => unknown` when a specific contract exists.
