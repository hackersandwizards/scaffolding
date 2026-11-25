# Assigning a variable or property to itself has no effect and usually indicates a typo.

Check surrounding code and tests to see what value was meant to be updated. Fix the target or source identifier if a write was intended, or delete the statement only after confirming it is dead code.

No fix: rewriting `x = x` as `x = (() => x)()`, or deleting it without checking for a missing update.
