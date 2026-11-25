# A production function longer than fifty lines usually performs more than one task.

A long function mixes calculation, branching, and side effects in one scope. Readers must trace the whole body to change or test any step.

Find the fix: identify each block of statements that performs one complete step. When a block requires a comment to explain its purpose, extract it into a function named for that purpose. Separate calculation from side effects: move decision logic into a pure function that returns a result value. Call it from a short function that runs the effect. Any extracted function must be named, described, and tested without mentioning the original function, and need none of its local state. Stop when each production function completes one task in fifty lines or fewer.

No fix: moving lines into a closure, a tail helper, or any helper that shuttles local variables or a state object between calls. Deleting blank lines or comments, or joining lines, is also no fix.
