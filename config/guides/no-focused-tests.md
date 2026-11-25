# A focused test makes the gate skip all other tests in the file and report green.

Remove `.only` from `test.only`, `it.only`, or `describe.only`, and replace `fit` or `fdescribe` with `test` or `describe`, so the full suite runs.
