# This generator function contains no `yield` expression.

Check callers and tests to see whether this function should produce a sequence of values. If so, `yield` the real items callers expect; otherwise remove `*` and return the value from a regular function.

No fix: adding a dead `yield;` or `yield undefined` just to satisfy the rule.
