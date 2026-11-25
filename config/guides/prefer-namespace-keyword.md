# The legacy `module Name {}` syntax conflicts with ES modules, and `namespace` blocks are also forbidden here.

Move the declarations into a standard ES module file with `export` and `import` statements. Keep only ambient declarations for external libraries without types, written as `declare module "name"`.

No fix: replacing `module` with `namespace`.
