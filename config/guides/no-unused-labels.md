# This statement label is declared but never targeted by `break` or `continue`.

Check nearby `break` or `continue` statements inside nested loops to see whether one was meant to exit this labelled loop. Target the label on that jump if so; delete the label only after confirming every jump exits the right loop.

No fix: deleting the label without checking whether an inner `break` or `continue` exits the wrong statement.
