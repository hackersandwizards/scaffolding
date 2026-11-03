// Needs eslint-plugin-astro in the repository, which an Astro repository has anyway.
import astro from "eslint-plugin-astro";
import prettier from "eslint-config-prettier/flat";
import base from "./eslint.js";

export default [
  ...base.slice(0, -1),
  ...astro.configs.recommended,
  { files: ["**/*.astro"], rules: { "@typescript-eslint/no-unused-vars": "off" } },
  prettier,
];
