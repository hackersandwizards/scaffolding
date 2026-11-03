// A repository with more Prettier plugins spreads this in its own prettier.config.js and lists
// these plugins with its own. Each plugin resolves from this package, since a name resolves from
// the folder Prettier runs in, where the plugin need not be installed.
import { fileURLToPath } from "node:url";

export default {
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 100,
  plugins: [fileURLToPath(import.meta.resolve("prettier-plugin-astro"))],
};
