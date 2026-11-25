# A promise is started without waiting for it or handling its rejection.

When a promise runs detached, its rejection is lost and subsequent statements execute before the asynchronous work completes.

Find the fix: `await` the promise when following code depends on its completion, or return it so the caller controls it. When the task runs in the background intentionally, attach `.catch(...)` so a failure reaches someone who can act: report it where the program reports errors, or fail the operation. Verify every created promise has an owner awaiting it or handling its rejection.

No fix: prefixing the expression with `void`, attaching an empty `.catch(() => {})`, or writing `.catch(console.log)` where no process monitors the console.
