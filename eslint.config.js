import base from "./config/eslint.js";

export default [
  ...base,
  { ignores: ["template/**", "template-catalog/**"] },
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
];
