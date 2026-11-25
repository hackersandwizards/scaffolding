# TypeScript `namespace` blocks duplicate ES module scoping and complicate bundling.

Move the declarations into an ES module file and share them with `export` and `import` statements. Ambient `declare namespace` blocks in `.d.ts` files are not reported, and are not an escape hatch for runtime code.

No fix: replacing the namespace with an exported object or an immediately invoked function that rebuilds the same shape.
