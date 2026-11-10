import base from "./config/eslint.js";

export default [
  ...base,
  {
    ignores: [
      "template/**/*",
      "!template/.githooks/",
      "!template/.githooks/check-lock.ts",
      "template-catalog/**",
    ],
  },
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
];
