# This `get` accessor can exit without returning a value.

Check callers and tests for what this property must return on the missing path. Return that real value on every path through the getter, or throw an error if that state is invalid.

No fix: adding `return undefined` or a placeholder value at the end of the getter.
