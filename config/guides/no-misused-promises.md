# A promise is placed where a synchronous value or void callback is expected.

Testing a promise in a condition always evaluates as true because a promise is an object, and passing an `async` callback to `forEach` or an event handler discards its returned promise and rejections.

Find the fix: `await` the promise before evaluating it in a condition so the test checks the resolved value. For `forEach`, switch to a `for...of` loop with `await`. For an event handler or void callback, handle rejections inside the callback so a failure reaches someone who can act: report it where the program reports errors, or fail the operation.

No fix: wrapping an `async` callback with `void`, leaving an empty `catch` inside the callback, or calling `console.log` where no process monitors the console.
