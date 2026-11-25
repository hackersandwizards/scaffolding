# Calling `toThrow()` without an argument passes on any thrown error, including an unintended bug.

Pass a specific error class, message string, or regular expression that callers rely on, so throwing a different error makes the test fail.

No fix: passing the base `Error` class (`toThrow(Error)`), an empty string (`toThrow("")`), or a broad pattern such as `/./` or `/error/`.
