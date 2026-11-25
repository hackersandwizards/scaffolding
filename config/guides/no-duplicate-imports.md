# The same module is imported in more than one statement.

Merge value imports from that module into one `import` statement under one path so each module appears once. A separate `import type` statement for the same module remains allowed. If merging changes import counts in a generated architecture document such as `docs/architecture/layers.md`, regenerate it with the repository's command.

No fix: importing the same module again through a different path spelling or alias, or editing generated import counts by hand.
