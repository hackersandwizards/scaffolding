# Code nested more than four blocks deep requires tracking five surrounding conditions at once.

Deeply nested blocks hide which preconditions guard the innermost statement and make early exit paths hard to trace.

Find the fix: check terminating conditions first and return early so the main path runs at the top block level and the reader follows fewer paths. When a loop body nests blocks, extract one iteration into a function of one item, leaving the loop with a single call. When nesting matches nested input data, flatten the data first, then process each item at one level. Any extracted function must be named, described, and tested without mentioning the original. It receives the data it works on as arguments, not the surrounding function's working variables one by one.

No fix: a rewrite whose only effect is that the linter stops counting while the reader still follows the same conditions at the same place. Examples include joining guards with `&&` or `every(Boolean)`, replacing a block with a ternary, or moving it to a helper passed the surrounding locals.
