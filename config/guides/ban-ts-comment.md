# A TypeScript suppression comment hides a compiler error instead of fixing the broken type.

Comments such as `@ts-ignore` and `@ts-nocheck` switch off type checking on broken code so real bugs pass the gate. Only `@ts-expect-error` with a description of at least three characters is allowed when an error is intentional.

Find the fix: delete the comment, run the type checker to read the error, and fix the type definition, narrowing check, or call signature until the code compiles cleanly. Use `@ts-expect-error` only when a test expects a type failure or an external declaration is broken, with a description stating why the compiler is wrong here.

No fix: replacing `@ts-ignore` with a cast to `any`, `as T`, or `as unknown as T`, or writing `@ts-expect-error` with a description that gives no reason such as `"fix later"`.
