# Using `arguments` hides parameter types and yields an array-like object instead of a real array.

Replace `arguments` with a typed rest parameter (`...args: T[]` or a tuple type) matching the exact argument contract callers rely on.

No fix: writing `...args: any[]`, or using `...args: unknown[]` when callers rely on concrete argument types.
