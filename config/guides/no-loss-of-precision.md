# This numeric literal exceeds JavaScript floating-point precision and rounds at run time.

Check callers and tests to see whether every digit must stay exact (such as an identifier or exact amount). Use a `BigInt` literal with an `n` suffix or a string when exactness matters; shorten the literal only when callers accept rounding.

No fix: dropping digits or writing the rounded number when callers require exact digits.
