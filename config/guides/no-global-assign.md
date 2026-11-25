# This statement overwrites a read-only built-in global such as `Object` or `undefined`.

Check which code was meant to read the assigned value. Remove the assignment if it was a mistake, or declare a local variable and update every intended reader to use that local binding instead of the global.

No fix: redirecting the assignment to a local variable that intended consumers do not read.
