# This condition is always true or always false at run time.

Check surrounding code and tests to see what should drive this branch. Fix the expression if the constant result is a bug, write the real loop exit condition for a `while (true)` loop, or delete the branch only after confirming it is dead code.

No fix: moving the constant into a variable to hide it, or deleting a branch without checking what it was for.
