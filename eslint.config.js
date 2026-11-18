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
  {
    // The nearest tsconfig, the template's, extends this package by a name that resolves only in a
    // repository that installs it; the root one includes the file.
    files: ["template/.githooks/**/*.ts"],
    languageOptions: { parserOptions: { projectService: false, project: "./tsconfig.json" } },
  },
];
