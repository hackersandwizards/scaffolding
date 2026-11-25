# A numeric literal starting with `0` uses legacy octal syntax forbidden in strict mode.

Check callers and tests to see whether this value is a decimal number or an octal bitmask. Remove the leading `0` for decimal, or use the `0o` prefix for octal.

No fix: dropping the leading `0` without checking whether an octal value was intended.
