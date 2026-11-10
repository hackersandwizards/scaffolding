// Its plugins are this package's dependencies, so a repository installs none of them itself.
import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

// The files check-coupling and check-unique-names count as tests.
const code = "{js,jsx,ts,tsx,mjs,cjs,mts,cts}";
const testFiles = [`**/{__tests__,test,tests,e2e}/**/*.${code}`, `**/*.{test,spec}.${code}`];
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
      // An error: a warning exits 0, so a gate read only when red never shows it.
      "@typescript-eslint/no-unused-vars": [
        "error",
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
          selector: `:matches(CallExpression[callee.name=${testCall}], CallExpression[callee.object.name=${testCall}], CallExpression[callee.object.object.name=${testCall}], CallExpression[callee.callee.object.name=${testCall}], CallExpression[callee.callee.object.object.name=${testCall}], CallExpression[callee.tag.object.name=${testCall}], CallExpression[callee.tag.object.object.name=${testCall}]) > :matches(ArrowFunctionExpression, FunctionExpression)[body.body.length=0]`,
          message: "An empty test body passes. Write the assertion or delete the test.",
        },
      ],
    },
  },
  prettier,
];
