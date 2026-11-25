# Two production files declare a module-scope function with the same name.

Duplicate names mean either the same logic was written twice or two distinct functions share a name too vague to distinguish them. Framework entry points such as `GET` or `getStaticPaths` and helpers inside test files are exempt.

Find the fix: read both implementations side by side. When they do the same task, keep one copy in the lowest layer both callers may import (see `docs/architecture/layers.md`) and update callers to import it. When they do different tasks, give each a name stating what it does differently, in the words a caller would use, so both names are distinct.

No fix: adding a numeric suffix, prepending a file name, or swapping to a vague synonym. Rewriting a declaration in another syntax, such as a `const` arrow function, so the check misses it is also no fix.
