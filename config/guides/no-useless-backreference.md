# This regex backreference always matches an empty string because its group cannot match beforehand.

Check callers and tests to see whether the pattern must enforce repeated text. If repetition is needed, reorder or unnest the capturing group so it matches before the backreference; delete the backreference only when repetition is not intended.

No fix: deleting the backreference when the pattern was meant to enforce repeated text.
