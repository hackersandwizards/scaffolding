# An `expect` call outside a test or helper runs during file load without naming a failing test.

Move it into the test whose title names that behaviour, or a helper called by that test, so breaking the behaviour reports that test.

No fix: wrapping it in a test with a filler title, calling it from an unrelated test, or deleting a still-needed check.
