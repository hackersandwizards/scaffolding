# A `let`, `const`, `function`, or `class` declaration in a `switch` case is scoped to the whole `switch`.

Wrap that `case` body in curly braces `{ ... }` so the declaration stays scoped to its branch.

No fix: switching to `var`, or moving the declaration above the `switch` when only one case uses it.
