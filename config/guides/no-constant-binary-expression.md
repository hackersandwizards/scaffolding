# This comparison or logical expression always produces the same result, usually from operator precedence.

Check surrounding code and tests for the condition intended here (common causes are precedence errors such as `!a == b` or `a ?? b || c`). Rewrite the operands or parentheses so both outcomes are reachable from runtime values.

No fix: moving a constant operand into a variable to hide it, or deleting an operand without fixing the logic.
