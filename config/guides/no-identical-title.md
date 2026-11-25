# Two tests or `describe` blocks share one title, so a failure report cannot identify which broke.

Rename each title to state the input or outcome that differs. If both check the same case, delete the duplicate so every title is unique.

No fix: adding a filler suffix such as `" (2)"` or `"again"`, or wrapping one in a generic `describe` block.
