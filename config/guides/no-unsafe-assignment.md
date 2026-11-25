# A value typed as `any` is assigned to a variable or property, bypassing type checking.

The finding appears at the assignment, while the root cause is where `any` entered the program and escaped validation.

Find the fix: trace the assigned value back to where its type became `any`, such as `JSON.parse`, an untyped import, a `catch` variable, or a missing generated type. Validate every field the code reads at that entry point with a type guard function (returning `value is T`) or a schema parser, and return a typed value so the assignment receives a checked type.

No fix: casting with `as T` or `as unknown as T` here or upstream, annotating a variable or return type without checking it, narrowing only with `typeof value === "object"`, or widening the target to `unknown` to skip validation.
