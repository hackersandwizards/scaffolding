# Two class members share the same name, so the later declaration overwrites the earlier one.

Check callers and tests to see which implementation is the live one and whether the class needs both behaviours. Delete the superseded duplicate, or rename one and update its callers when both behaviours are needed.

No fix: renaming one duplicate to an unused name such as `method2` without updating callers.
