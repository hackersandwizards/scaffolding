# This `describe` block defines the same lifecycle hook more than once.

Check which tests need each setup first. If every test needs both, merge them into one hook in order. If different tests need different setups, split them into separate `describe` blocks, each with its own hook.

No fix: concatenating unrelated setups into one hook for all tests.
