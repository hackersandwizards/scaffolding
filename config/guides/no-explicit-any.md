# Writing `any` switches off type checking for every expression that value touches.

An `any` annotation spreads unchecked assumptions across callers and return types, letting runtime type errors pass the compiler undetected.

Find the fix: for external data such as JSON, network responses, or untyped libraries, type the value as `unknown` where it enters the program. Validate every field the code reads using a type guard function (returning `value is T`) or a schema parser, and return a typed value. For data your own code produces, write the concrete type or generic type parameter directly. Confirm no `any` type or alias resolving to `any` remains.

No fix: casting with `as T` or `as unknown as T`, annotating a variable or return type without checking it, narrowing only with `typeof value === "object"`, defining an `[key: string]: any` index signature, or using an alias such as `ReturnType<typeof JSON.parse>`.
