# Reassigning the `catch` parameter overwrites the caught error reference.

Check what the `catch` block is meant to report or return. Store any replacement error in a new local variable, passing `{ cause: error }` if you throw it so the original failure stays attached.

No fix: throwing a replacement error from a new variable without keeping the original error as `cause`.
