# The type `{}` accepts any non-nullish value, including primitives, rather than only an empty object.

Choose the type matching the contract callers rely on: `object` for any non-primitive, `Record<string, never>` for an object with no properties, `NonNullable<unknown>` for any value except `null` and `undefined`, or `unknown` only when `null` and `undefined` are also accepted.

No fix: replacing `{}` with `unknown` when callers rely on rejecting `null` and `undefined`.
