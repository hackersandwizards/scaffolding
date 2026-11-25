# A `set` accessor ignores any value returned from it.

Check whether the returned expression does work the setter needs, such as `return save(value)`. Run that expression as a statement and remove only the returned value, using a bare `return;` if an early exit is needed.

No fix: deleting the expression inside `return` when evaluating it updates state.
