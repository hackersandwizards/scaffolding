# Writing `!a in b` or `!a instanceof B` negates `a` instead of the whole test.

Wrap the expression in parentheses, such as `!(a in b)` or `!(a instanceof B)`, so negation applies to the boolean result.
