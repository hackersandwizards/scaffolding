# This `await` operates on a value that is not a promise.

Check the called function and tests to see whether it is synchronous or performs asynchronous work it fails to return. Remove `await` when the work is synchronous; return the real promise covering all async work when callers must wait for it.

No fix: wrapping a synchronous value in `Promise.resolve(...)`, marking a function `async` while leaving background work unawaited, or deleting `await` without checking the callee.
