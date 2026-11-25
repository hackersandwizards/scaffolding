# A value typed as `any` is passed as an argument, disabling type checking on that call.

The finding appears at the call site, while the root cause is where `any` entered the program and spread unchecked.

Find the fix: trace the argument back to where its type became `any`, such as `JSON.parse`, an untyped import, a `catch` variable, or a missing generated type. Validate every field the code reads at that entry point with a type guard function (returning `value is T`) or a schema parser, and return a typed value so the call site receives a checked type.

No fix: casting with `as T` or `as unknown as T` at the call site or in an upstream temporary, annotating a variable or return type without checking it, or narrowing only with `typeof value === "object"`.
