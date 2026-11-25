# Merging an `interface` and a `class` with the same name skips compiler checks on interface members.

Give the interface a distinct name, add `implements` to the class, and update callers that used the merged type, or move real implemented members into the class body so TypeScript verifies them.

No fix: renaming the interface without connecting it via `implements`, or adding uninitialised `declare` fields to the class.
