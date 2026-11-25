# Calling `fn.apply(null, args)` is harder to read and type-check than spread syntax.

Replace `fn.apply(null, args)` with `fn(...args)` (or `fn(...Array.from(args))` for an array-like object) so TypeScript checks the argument types directly.

No fix: replacing `fn.apply` with `Reflect.apply(fn, null, args)`.
