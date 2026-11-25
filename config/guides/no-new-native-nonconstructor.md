# Calling `new Symbol(...)` or `new BigInt(...)` throws a `TypeError` at run time.

Remove `new` and call `Symbol(...)` or `BigInt(...)` as a regular function.
