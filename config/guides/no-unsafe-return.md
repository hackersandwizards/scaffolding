# A function returns a value typed as `any`, leaking an unchecked value to callers.

The finding appears at the `return` statement, while the root cause is where `any` entered the program earlier.

Find the fix: trace the returned expression back to where its type became `any`, such as `JSON.parse`, an untyped import, a `catch` variable, or a missing generated type. Validate every field the code reads at that entry point with a type guard function (returning `value is T`) or a schema parser, so the function returns a checked type.

No fix: casting at the `return` line or upstream, annotating a variable or return type without checking it, narrowing only with `typeof value === "object"`, or widening the return type to `unknown` to skip validation.
