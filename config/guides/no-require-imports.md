# Calling `require()` in TypeScript bypasses static ES module analysis and type checking.

Replace `require(...)` with a static ES `import` statement for fixed dependencies, or `await import("name")` when a dependency must load on demand.

No fix: using `createRequire` or hiding `require` behind a local alias.
