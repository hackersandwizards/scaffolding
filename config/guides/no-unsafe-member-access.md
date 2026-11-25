# A property is read from a value typed as `any`, leaving the access unchecked.

The finding appears at the property read, while the root cause is where `any` entered the program without a known shape.

Find the fix: trace the object back to where its type became `any`, such as `JSON.parse`, an untyped import, a `catch` variable, or a missing generated type. Validate every field the code reads at that entry point with a type guard function (returning `value is T`) or a schema parser, so TypeScript verifies the accessed property exists.

No fix: casting the object with `as T` or `as unknown as T` here or in an upstream temporary, annotating a variable or return type without checking it, or narrowing only with `typeof value === "object"`.
