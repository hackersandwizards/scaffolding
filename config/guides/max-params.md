# This function takes more than three parameters because a concept is unnamed or a responsibility is misplaced.

A long parameter list indicates missing domain types, mixed behaviours, or pass-through dependencies. Inspect the call sites to see which arguments appear together.

Find the fix: combine values that belong together across call sites into one named domain type, such as a date range or an invoice line. Split a function taking a boolean or mode flag into two functions named for each behaviour. For a parameter forwarded unchanged to an inner call, move that call to the caller. Otherwise pass that dependency once when creating the module, such as in a factory function or constructor. Stop when each function takes three or fewer parameters.

No fix: passing the same loose values in an `options` or `Context` object, a tuple, an array, or a rest parameter, or moving one to a module-level variable. Splitting the function so each half takes three parameters, or currying, is also no fix.
