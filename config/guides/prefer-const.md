# This `let` binding is never reassigned.

Replace `let` with `const` so readers can rely on the binding keeping its initial reference. If this file is generated, update the generator instead of editing the output.

No fix: adding a pointless reassignment such as `x = x` to keep `let`.
