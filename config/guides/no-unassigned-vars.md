# This `let` or `var` variable is read without ever receiving a value, so it is always `undefined`.

Check surrounding code and tests to find where this variable's value was meant to come from. Assign that real value before reading it, or delete the variable and its dead reads only after confirming it is obsolete.

No fix: initialising the variable to `undefined` or a placeholder such as `0` or `""`.
