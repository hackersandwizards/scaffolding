# Applying `delete` to a declared variable fails in strict mode and has no effect.

Check whether later code expects this state to be cleared. Assign `undefined` to a `let` binding if later reads expect it cleared, use `delete` only on an object property, or remove the line when no clearing is needed.

No fix: deleting the statement while leaving stale state that later code expects cleared.
