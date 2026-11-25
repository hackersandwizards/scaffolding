# This `switch` over a union type omits one or more union members.

When a union gains a new member later, an incomplete `switch` skips that member without a compiler error and produces wrong results at run time.

Find the fix: add an explicit `case` for each missing union member and implement the behaviour required for that variant. Confirm every member of the union has a matching branch so TypeScript catches future additions automatically.

No fix: adding a `default` branch that performs no work or returns a placeholder value, adding a `case` that throws `"not implemented"` or copies another branch without a real decision, or narrowing the type before the `switch` to hide the missing member.
