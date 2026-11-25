# This function has more than ten branches and handles more than one job.

The score starts at one and adds one for each `if`, loop, `case`, `&&`, `||`, `?:`, and every other operator that branches. Each branch adds a path to trace and test.

Find the fix: list every branch and separate distinct responsibilities. Replace type, status, or mode dispatch with a lookup table from key to value or handler so the reader follows fewer paths. Move input checks into one parsing function where raw input enters, returning a validated value. Any extracted function must be named and described without mentioning the original, taking its data as arguments rather than surrounding locals. Write a direct test for every extracted function, and move any factual comment (ordering constraint, external quirk, or guarded bug) with its code. Stop when each function owns one task with ten or fewer branches.

No fix: a rewrite whose only effect is that the linter stops counting while the reader still follows the same conditions at the same place. Examples include `??` for an `if`, `every(Boolean)`, a helper passed the surrounding locals, a lint disable comment, or a higher limit.
