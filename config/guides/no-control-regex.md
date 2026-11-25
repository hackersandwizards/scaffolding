# This regular expression contains an invisible control character (`\x00` to `\x1F`), nearly always a typing or escaping mistake.

Remove mistakes; use `\t`, `\n`, and `\r` for tab, line feed, and carriage return. Use `/\p{Cc}/u` only for every control character (`U+0000` to `U+001F`, `U+007F` to `U+009F`). For specific ones, check outside regex preserving position and repetition, not only presence.

No fix: widening to `/\p{Cc}/u`, or hiding the pattern in `new RegExp(...)`.
