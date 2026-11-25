# An assignment appears inside a conditional test where a comparison is usually intended.

Check surrounding code and tests to see whether this line compares values or intentionally assigns. Replace `=` with `===` when comparing; if assignment is intentional, move it above the condition and test the variable.

No fix: wrapping an accidental assignment in parentheses, or moving a typo assignment above the condition.
