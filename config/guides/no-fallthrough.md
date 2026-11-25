# This `switch` case runs into the next case without terminating.

Check surrounding code and tests to see whether the case ends here or shares work with the next case. Add `break`, `return`, or `throw` when it ends. Stack empty labels (`case a: case b:`) for identical handlers. Move shared work into a function both cases call when the first does its own work first.

No fix: adding a `// falls through` comment for an accidental fall, or adding `break` without checking.
