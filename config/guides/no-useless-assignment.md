# This assigned value is overwritten or leaves scope before any code reads it.

Check surrounding code and tests to see whether this assignment is dead code or a missing read. Delete the assignment only if the value is unneeded; otherwise use the value where the missing behaviour belongs.

No fix: adding a dummy read such as `void value` that discards the result, or deleting the assignment without checking for a missing read.
