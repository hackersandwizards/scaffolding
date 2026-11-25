# This `else if` condition duplicates an earlier branch, so its body never executes.

Check surrounding branches and tests to see which case the second body was meant to handle. Fix its condition so no earlier branch already matches it, or delete it only after confirming its body is redundant.

No fix: writing `test && extra` while an earlier `test` branch still wins, or deleting the branch without checking its body.
