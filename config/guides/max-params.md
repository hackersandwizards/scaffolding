# This function takes more than three parameters because a concept is unnamed or a responsibility is misplaced.

A long parameter list indicates missing domain types, mixed behaviours, or pass-through dependencies. Inspect the call sites to see which arguments appear together.

Find the fix: group values into a named domain type (a date range or invoice line) only where callers already have them together as one thing. Split a function taking a boolean or mode flag into two functions named for each behaviour. For a parameter forwarded unchanged to an inner call, move that call to the caller. Otherwise pass that dependency once when creating the module, such as in a factory function or constructor. Where a third-party library calls your callback with four or more positional arguments (such as a highlighter's token hook), pick another library hook taking one value. Stop when each function takes three or fewer parameters.

No fix: passing loose values in an `options` or `Context` object, or in a named type assembled inline at each call site from loose values. Passing them via a tuple, an array, a rest parameter, or a module-level variable is also no fix. Splitting into halves of three, wrapping a library callback (which only moves the parameters), or currying is also no fix.
