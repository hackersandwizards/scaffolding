# Combining `?.` with `!`, as in `a?.b!`, treats a value as optional and guaranteed at once.

Decide first from callers and data flow whether the value can be missing. If it can, remove `!` and handle the missing case where it matters (return early or report an error). Remove `?.` only when surrounding checks guarantee presence.

No fix: a placeholder fallback such as `?? []` or `?? 0`, replacing `!` with `as T`, or removing `?.` without confirming presence.
