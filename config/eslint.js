// Its plugins are this package's dependencies, so a repository installs none of them itself.
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";
import { submodulePaths } from "./submodules.js";

// The files check-coupling counts as tests.
const code = "{js,jsx,ts,tsx,mjs,cjs,mts,cts}";
const testFiles = [`**/{__tests__,test,tests,e2e}/**/*.${code}`, `**/*.{test,spec}.${code}`];
const propertyFiles = [`**/*.prop.test.${code}`];
const testCall = "/^(it|test|describe)$/";
const propertyCall =
  "CallExpression[callee.callee.property.name='prop']" +
  ":matches([callee.callee.object.name=/^(it|test)$/], [callee.callee.object.object.name=/^(it|test)$/], [callee.callee.object.object.object.name=/^(it|test)$/])";
const propertyLocation = {
  selector: propertyCall,
  message: "Move this property to a *.prop.test.* file so exploration can run it.",
};
const testRules = [
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
  tseslint.configs.recommended[0],
  {
    ...tseslint.configs.recommended[1],
    rules: {
      ...tseslint.configs.recommended[1].rules,
      "no-var": "off",
      "prefer-const": "off",
      "prefer-rest-params": "off",
      "prefer-spread": "off",
    },
  },
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.bunBuiltin } },
    rules: {
      "no-dupe-args": "error",
      "no-octal": "error",
      "no-useless-assignment": "error",
    },
  },
  {
    files: [`**/*.${code}`],
    rules: {
      "no-restricted-syntax": ["error", propertyLocation],
    },
  },
  {
    // An `it("...", () => {})` passes, so a gutted test reads as a covered one.
    files: testFiles,
    rules: {
      "no-restricted-syntax": ["error", ...testRules, propertyLocation],
    },
  },
  {
    files: propertyFiles,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...testRules,
        {
          selector:
            `${propertyCall} > :matches(ArrowFunctionExpression, FunctionExpression)` +
            ":not(:has(CallExpression[callee.name=/^(expect|expectTypeOf|assertType|assert)$/], CallExpression[callee.object.name='assert']))",
          message: "A property callback must assert its result.",
        },
      ],
    },
  },
  prettier,
];
