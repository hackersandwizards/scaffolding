# Throwing a new error in `catch` without `{ cause }` discards the original message and stack trace.

Pass `{ cause: error }` as the second argument to the new `Error` constructor, and write a message stating what the code was doing when it failed rather than repeating the original message.

No fix: repeating the original error's message without adding what failed here.
