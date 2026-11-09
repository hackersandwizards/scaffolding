// Needs eslint-plugin-astro in the repository, which an Astro repository has anyway.
import astro from "eslint-plugin-astro";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";
import base from "./eslint.js";

export default [
  ...base.slice(0, -1),
  ...astro.configs.recommended,
  // eslint-plugin-astro loads the TypeScript parser from the working directory, which an
  // isolated install of the repository lacks: without it, TypeScript in an .astro file fails to parse.
  {
    files: ["**/*.astro"],
    processor: "astro/client-side-ts",
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
  prettier,
];
