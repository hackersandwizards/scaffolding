# A value typed as `any` is called as a function, leaving arguments and return type unchecked.

The finding appears at the call, while the root cause is where `any` entered the program without a checked function type.

Find the fix: trace the callee back to where its type became `any`, such as an untyped import, `JSON.parse`, a `catch` variable, or a missing generated type. Validate it at that entry point with a type guard function (returning `value is T`) or a schema parser, or supply verified module types, so TypeScript checks every argument and return value.

No fix: casting the callee here or upstream, annotating a variable or return type with a guessed signature without checking it, or narrowing only with `typeof value === "object"`.
