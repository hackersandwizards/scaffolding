# Code nested more than four blocks deep requires tracking five surrounding conditions at once.

Deeply nested blocks hide which preconditions guard the innermost statement and make early exit paths hard to trace.

Find the fix: check terminating conditions first and return early, so the main path runs at the top block level. When a loop body nests blocks inside it, extract one complete iteration into a function of one item, leaving the loop with a single call. When nesting matches nested input data, flatten the data into a single list first, then process each element at one level of indentation. Any extracted function must be named, described, and tested without mentioning the original function, and need none of its local state.

No fix: joining nested conditions into one long `&&`, joining early returns into one long `||`, or rewriting the innermost block as a ternary or short-circuit expression. Moving an inner block into a closure or helper that still depends on the surrounding local state or preconditions is also no fix, whatever its name.
