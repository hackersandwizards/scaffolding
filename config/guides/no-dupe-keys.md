# Two properties in this object literal share the same key, overwriting the earlier value.

Check callers and tests to see which key-value pair is right and whether one key was misspelled. Keep the intended entry or fix the misspelled key so every property matches what callers expect.

No fix: deleting an entry without checking which value is right, renaming to an unused key, or hiding the duplicate behind a computed key.
