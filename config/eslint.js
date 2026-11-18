// Its plugins are this package's dependencies, so a repository installs none of them itself.
import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";
import { submodulePaths } from "./submodules.js";

// The files check-coupling counts as tests.
const code = "{js,jsx,ts,tsx,mjs,cjs,mts,cts}";
const testFiles = [`**/{__tests__,test,tests,e2e}/**/*.${code}`, `**/*.{test,spec}.${code}`];
const testCall = "/^(it|test|describe)$/";
// The type program costs a commit of three files more than a second (1.9 s against 0.45 s), so
// check-staged sets this and the typed rules run in the gate's lint step alone.
const typed = !process.env.SCAFFOLDING_LINT_UNTYPED;
const typedRules = [
  "no-floating-promises",
  "no-misused-promises",
  "await-thenable",
  "switch-exhaustiveness-check",
  "no-unsafe-assignment",
  "no-unsafe-member-access",
  "no-unsafe-argument",
  "no-unsafe-call",
  "no-unsafe-return",
];

export default [
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "**/dist/**",
      "**/.astro/**",
      ".claude/**",
      ".githooks/**",
      ...submodulePaths().map((path) => `${path}/**`),
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.bunBuiltin } },
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
        {
          selector:
            "MemberExpression[property.name=/^(rejects|resolves)$/]:matches([object.callee.name='expect'], [object.object.callee.name='expect'])",
          message:
            "Under bun, expect().rejects and .resolves wait in a nested event loop, where a shared puppeteer connection broke; await rejection() from @hackersandwizards/scaffolding/rejection, or await the promise, then expect what it settled to.",
        },
      ],
    },
  },
  ...(typed
    ? [
        {
          files: ["**/*.{ts,tsx,mts,cts}"],
          languageOptions: { parserOptions: { projectService: true } },
          rules: Object.fromEntries(
            typedRules.map((rule) => [`@typescript-eslint/${rule}`, "error"]),
          ),
        },
      ]
    : []),
  prettier,
];
