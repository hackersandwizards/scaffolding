# An `async` function passed to `new Promise(...)` loses thrown errors and masks rejections.

Write an `async` function directly instead of wrapping it in `new Promise(...)`, or keep the executor synchronous and pass every failure to `reject`.

No fix: making the executor synchronous while calling an `async` function or IIFE inside it without passing its rejection to `reject`.
