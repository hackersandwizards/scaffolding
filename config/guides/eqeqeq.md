# Loose equality coerces operand types before comparing values.

Replace `==` with `===` and `!=` with `!==`; `== null` and `!= null` remain allowed for `null` or `undefined`. When types differ, convert once where the value enters the program (such as parsing a string to a number), then compare with `===`.

No fix: any conversion at the comparison itself, such as `String(a) === String(b)` or `Number(a) === b`.
