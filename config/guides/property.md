# This property test breaks a shared suite convention for discovery, imports, reproducibility, or assertions.

Shared seed and run-count settings keep property failures reproducible across the suite, and the `*.prop.test.*` filename lets long randomised test runs find every property test.

Find the fix: act on the specific convention the finding line names. Keep property tests in `*.prop.test.ts` files and example tests in ordinary test files. Import `test` and `fc` as named imports from `@hackersandwizards/scaffolding/property` instead of `fast-check` or `@fast-check/vitest`. Declare properties with `test.prop([...])("title", (values) => { ... })` and assert the result inside the callback. Pass options as an inline object, removing only `seed` and `numRuns` while keeping any other options.

No fix: setting a per-property `seed` that happens to pass, or deleting unrelated options instead of removing only `seed` and `numRuns`. Narrowing the generator to skip inputs that fail under the shared settings is also no fix.
