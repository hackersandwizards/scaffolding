# An empty `[]` character class in a regular expression matches no character.

Check surrounding code and tests for which strings the pattern must match and reject. Put the intended characters inside `[...]`, or escape literal brackets as `\[` and `\]`, and verify against matching and non-matching inputs.

No fix: putting an arbitrary character or `.` inside the pattern just to make it match.
