# A variable passed through `define:vars` is never referenced in the `<style>` block.

Check whether the `<style>` block is meant to style elements with this variable. Reference it as `var(--name)` inside a rule that styles rendered elements, or remove it from `define:vars` if unused.

No fix: referencing `var(--name)` in a dead selector or unused custom property, or removing it without checking the intended style.
