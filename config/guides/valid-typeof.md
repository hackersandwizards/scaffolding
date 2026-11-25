# A `typeof` result is compared against a string that `typeof` can never return.

Check what type this branch was meant to test. Fix a typo to a valid `typeof` string (`"undefined"`, `"object"`, `"boolean"`, `"number"`, `"string"`, `"function"`, `"symbol"`, `"bigint"`), or use `Array.isArray(x)` or `x === null` when `typeof` cannot distinguish it.

No fix: replacing `'array'` with `'object'` or picking any valid string that tests the wrong type.
