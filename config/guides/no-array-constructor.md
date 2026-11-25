# Calling `Array(...)` without a single length argument is ambiguous and error-prone.

Replace `new Array()` or `new Array(a, b)` with an array literal such as `[]` or `[a, b]`. To build an array of a given length, use `Array.from({ length: n })`.

No fix: adding a type argument such as `new Array<T>(...)` to keep the constructor call.
