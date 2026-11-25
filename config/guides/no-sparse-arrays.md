# Consecutive commas in an array literal create empty slots that iteration methods skip.

Check callers and tests to see whether the extra comma is a typo or an intended position. Remove the extra comma if accidental; write `undefined` only when callers expect that index and iteration methods should visit it.

No fix: filling an accidental hole with `undefined` without checking how callers iterate the array.
