# A `var` declaration ignores block scope and is lifted to the top of its function as `undefined` before its assignment runs.

Declare the binding in the narrowest block that uses it, moving it above its first read if code previously relied on `var` lifting. Use `const`, or `let` only when the binding is reassigned. If this file is generated, update the generator instead.
