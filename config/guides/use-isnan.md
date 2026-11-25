# Comparing directly with `NaN` using `===` or `!==` never matches `NaN` values.

Replace `x === NaN` (or `x == NaN`) with `Number.isNaN(x)`, and replace `x !== NaN` (or `x != NaN`) with `!Number.isNaN(x)`.
