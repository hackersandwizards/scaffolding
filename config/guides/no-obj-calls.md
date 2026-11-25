# A built-in global object such as `Math`, `JSON`, `Reflect`, `Atomics`, or `Intl` is called as a function.

Check surrounding code and tests for the operation intended here. Call the matching static method or constructor on that namespace, such as `Math.max(...)`, `JSON.parse(...)`, or `new Intl.NumberFormat(...)`.

No fix: calling an arbitrary method on the built-in that performs a different operation.
