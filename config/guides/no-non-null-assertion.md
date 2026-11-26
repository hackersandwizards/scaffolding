# The `!` non-null assertion claims a value is never missing without checking.

Either the type is wrong or the missing case is unhandled, and `!` hides which one it is. When the assumption breaks at runtime, the failure surfaces later as a type error far from the missing value.

Find the fix: correct the type at its source so the value cannot be missing, or handle the missing case where it arises (throw an error naming what is missing, or take the branch the missing case needs). In tests, call `defined(value, "what")` from `@hackersandwizards/scaffolding/defined` so a missing value fails with what was expected.

No fix: casting with `as T`, `?? (x as never)`, `// @ts-expect-error`, optional chaining that turns a missing value into a silent `undefined`, or a lint disable comment.
