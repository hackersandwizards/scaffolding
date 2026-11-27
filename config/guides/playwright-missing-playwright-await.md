# Playwright is still working when the test moves on

Find the fix: Await the Playwright action or assertion before checking its result. The assertion after a missing await may check nothing.

No fix: Adding a delay before the next line.
