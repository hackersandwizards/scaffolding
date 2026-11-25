# TypeScript `namespace` blocks duplicate ES module scoping and prevent bundlers from dropping unused members.

Move the declarations into an ES module file with `export` and `import` statements. Ambient `declare namespace` blocks in `.d.ts` files are not reported and are not an escape hatch for runtime code.

No fix: any construct that only rebuilds the same grouping, such as an exported object, an immediately invoked function, or a class of static members.
