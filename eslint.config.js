import base from "./config/eslint.js";

export default [
  ...base,
  {
    ignores: [
      "template/**/*",
      "!template/.githooks/",
      "!template/.githooks/**",
      "template-catalog/**",
    ],
  },
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
];
