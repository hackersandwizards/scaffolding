# Two or more modules import each other at run time, creating a circular dependency.

When module A and module B import each other, you cannot understand, test, or move either module independently, and module initialisation order becomes fragile.

Find the fix: identify the import that points in the wrong direction. Check `docs/architecture/layers.md` if present, or decide which module should stay independent of its caller when both share a layer. If an import uses only types, change it to `import type`, which TypeScript erases at run time. For shared runtime code, extract it into a lower-layer module both may import, or pass the needed value as a parameter. Verify that the module graph has no cycles.

No fix: replacing a static import with dynamic `import()`, merging both files, or copying the needed code into the importing file. Routing the dependency through a global, callback, or mutable registry that one module writes and the other reads is also no fix.
