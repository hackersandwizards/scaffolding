# Reassigning a `const` binding throws a `TypeError` at run time.

Check surrounding code and callers first: is this write a mistake targeting the wrong variable, or is the value designed to change? Fix the target variable if the write is a mistake; change `const` to `let` only when the value is meant to change.

No fix: changing `const` to `let` without checking whether the write itself is a bug.
