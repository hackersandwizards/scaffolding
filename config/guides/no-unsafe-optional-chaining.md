# An optional-chained value that may be `undefined` is used where `undefined` throws at run time.

Decide first from callers and data flow whether the value can be missing. If it can, handle the missing case where it matters (return early or report an error) before using it. Remove `?.` only when surrounding checks guarantee presence.

No fix: a placeholder fallback such as `?? []`, `?? {}`, or `?? 0`, adding `!`, or removing `?.` without confirming presence.
