# Comparing against `-0` with standard operators treats `-0` and `+0` as equal.

Use `Object.is(value, -0)` when negative zero must be distinguished, or compare against `0` when the sign does not matter.
