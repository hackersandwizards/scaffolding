# Code after `return`, `throw`, `break`, or `continue` never executes.

Check callers and tests to see whether the unreachable block implements required behaviour or is leftover code. Fix or move the earlier exit statement if the code below must run; delete it only after confirming it is obsolete.

No fix: deleting unreachable statements without checking whether the earlier exit is the bug.
