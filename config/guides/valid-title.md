# This test or `describe` title is empty, non-string, padded, or starts with `test`, `it`, or `describe`.

Write a trimmed string title stating the behaviour the assertions verify, without starting with `test`, `it`, or `describe`. For a title in a variable, use `test.each` with a title pattern.

No fix: wrapping a variable in a bare template literal, a generic title (`"works"`), or naming only the function. A title not matching the assertions is also no fix.
