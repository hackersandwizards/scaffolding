# Reassigning a declared function overwrites its binding unexpectedly.

Check surrounding code and callers first: is this write a typo targeting the wrong variable, or a value meant to change? Fix the target variable if it is a mistake; declare a separate `let` binding only for a value meant to change, and update its readers.

No fix: turning the function declaration into a `let` function expression to keep overwriting it.
