# This `describe` block defines the same lifecycle hook more than once.

Remove one hook's body temporarily to see which tests fail and need it. Split tests needing different setup into separate `describe` blocks. When every test needs both, merge them keeping `before` order. The later-defined `afterEach` ran first until now, so its body goes first in the merged hook.

No fix: merging unrelated setups, or nesting a `describe` only for the second hook while every test still runs both.
