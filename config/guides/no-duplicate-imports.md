# The same module is imported in more than one statement.

Merge value imports from that module into a single `import` statement under one consistent path so each module is imported once. A separate `import type` statement for the same module remains allowed.

No fix: importing the same module again through a different path spelling or alias.
