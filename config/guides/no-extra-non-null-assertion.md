# Repeated `!` non-null assertions such as `a!!.b` have no extra effect.

The remaining single `!` is still an unchecked claim. Check whether the value can be absent: if it can, remove both `!` operators and handle `undefined` explicitly. Remove only the extra `!` when surrounding checks already guarantee presence.

No fix: dropping one `!` and leaving an unchecked `!` on a value that can be absent.
