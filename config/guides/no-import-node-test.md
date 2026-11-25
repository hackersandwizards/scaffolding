# Tests imported from `node:test` do not execute under the Vitest gate.

Replace the `node:test` import with `test`, `describe`, and `expect` from `vitest`, and replace any `node:assert` calls with `expect` matchers, so the gate runs the file.
