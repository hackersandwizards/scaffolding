// The flat config every repository shares. A repository spreads it and appends its own entries:
// `export default [...base, { ignores: [...] }, ...]`. Its plugins are this package's
// dependencies, so a repository installs none of them itself.
import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

const testFiles = ["**/__tests__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "test/**/*.{ts,tsx}"];
const testCall = "/^(it|test|describe)$/";

export default [
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "dist/**",
      "**/.astro/**",
      ".claude/**",
      ".githooks/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // An `it("...", () => {})` passes, so a gutted test reads as a covered one.
    files: testFiles,
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `:matches(CallExpression[callee.name=${testCall}], CallExpression[callee.object.name=${testCall}], CallExpression[callee.callee.object.name=${testCall}], CallExpression[callee.callee.object.object.name=${testCall}], CallExpression[callee.tag.object.name=${testCall}], CallExpression[callee.tag.object.object.name=${testCall}]) > :matches(ArrowFunctionExpression, FunctionExpression)[body.body.length=0]`,
          message: "An empty test body passes. Write the assertion or delete the test.",
        },
      ],
    },
  },
  prettier,
];
