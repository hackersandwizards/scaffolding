# Reassigning a class binding overwrites the class reference itself.

Check surrounding code and callers first: is the write a mistake targeting the wrong variable, or a value meant to change? Fix the target variable if it was a mistake, or declare a separate `let` variable and update its intended readers.

No fix: turning the class into a `let` class expression to keep overwriting it, or writing to an unused local variable.
