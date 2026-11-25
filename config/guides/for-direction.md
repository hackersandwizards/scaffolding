# This `for` loop updates its counter in the wrong direction relative to its stop condition.

Check surrounding code and tests for the intended start, end, and step of the loop. Fix the counter update (`++` vs `--`) or stop condition so the loop visits the intended range and terminates.

No fix: flipping the comparison so the loop exits immediately after zero iterations.
