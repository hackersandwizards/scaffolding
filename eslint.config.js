// The package lints itself with the config it ships.
import base from "./config/eslint.js";

export default [
  ...base,
  { ignores: ["template/**"] },
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
];
