# Triple-slash `/// <reference ... />` directives are legacy TypeScript syntax.

Replace module or path references with standard `import` or `import type` statements. When the directive loads ambient types with no import form (such as a bundler's client types), add that package to the `types` list in `tsconfig.json`.

No fix: deleting the directive without verifying its types still resolve, or adding a stub local declaration.
