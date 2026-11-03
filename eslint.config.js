import base from "./config/eslint.js";

export default [
  ...base,
  { ignores: ["template/**", "surface/**", "admin-area/**"] },
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
];
