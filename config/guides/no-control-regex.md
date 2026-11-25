# This regular expression contains an ASCII control character (`\x00` to `\x1F`).

Remove an accidental character; write tab, line feed, and carriage return as `\t`, `\n`, and `\r`. Use `/\p{Cc}/u` only to match every control character (`U+0000` to `U+001F` and `U+007F` to `U+009F`). For specific ones, check outside regex with `text.includes("\u0000")` or code-point comparisons.

No fix: widening a narrow match to `/\p{Cc}/u`, or hiding the pattern in `new RegExp(...)`.
