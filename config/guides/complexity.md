# This function has more than ten branches and handles more than one job.

The score starts at one and adds one for each `if`, loop, `case`, `&&`, `||`, `?:`, and every other operator that branches. Each branch adds a path to trace and test.

Find the fix: list every branch. Replace type, status, or mode dispatch with a lookup table from key to value or handler. Move input checks into one parsing function where raw input enters, returning a validated value. Any extracted function must be named, described, and tested without mentioning the original, using none of its local state. Keep only branches for this function's task until ten or fewer remain.

No fix: splitting into `stepOne` and `stepTwo`, or moving branches into a closure, helper, or predicate while the original owns the same decisions. Rewriting a branch as `?:`, `??`, a default parameter, or `Math.min` while keeping the same decisions is also no fix. Do not add a lint disable comment or raise the limit.
