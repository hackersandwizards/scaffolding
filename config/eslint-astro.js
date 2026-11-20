import js from "@eslint/js";
import astro from "eslint-plugin-astro";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";
import { astroTypePrograms } from "./eslint-astro-script.js";
import base from "./eslint.js";
import oxlint from "./oxlint.json" with { type: "json" };

const astroFiles = ["**/*.astro"];
const scriptFiles = ["**/*.astro/*.ts"];
const astroPreset = astro.configs.recommended;
const astroParser = astroPreset.find((config) => config.name === "astro/base").languageOptions
  .parser;
const originalProcessor = astro.processors["client-side-ts"];
const scripts = astroTypePrograms(originalProcessor, astroParser);
const frontmatter = new Map();
const retained = new Set(["no-dupe-args", "no-octal", "no-undef", "no-useless-assignment"]);
const componentRules = {
  ...js.configs.recommended.rules,
  ...tseslint.configs.recommended.find((config) => config.name === "typescript-eslint/recommended")
    .rules,
  "no-empty": ["error", { allowEmptyCatch: true }],
  "@typescript-eslint/no-unused-vars": "off",
};
const typedRules = Object.fromEntries(
  Object.keys(
    oxlint.overrides.find(({ rules }) => Object.hasOwn(rules, "typescript/no-floating-promises"))
      .rules,
  ).map((rule) => [rule.replace("typescript/", "@typescript-eslint/"), "error"]),
);

const processor = {
  meta: { ...originalProcessor.meta, name: "scaffolding/astro" },
  supportsAutofix: true,
  preprocess(code, filename) {
    try {
      const template = astroParser.parseTemplate(code);
      const block = template.result.ast.frontmatter;
      frontmatter.set(filename, block ? template.getLocFromIndex(block.end).line : 0);
    } catch {
      // The Astro parser reports the syntax error itself.
      frontmatter.delete(filename);
    }
    return scripts.preprocess(code, filename);
  },
  postprocess([component, ...blocks], filename) {
    const end = frontmatter.get(filename);
    frontmatter.delete(filename);
    // Oxlint processes frontmatter and scripts, but does not read expressions in the template.
    const messages = component.filter(
      ({ ruleId, line }) =>
        end === undefined ||
        line > end ||
        !Object.hasOwn(componentRules, ruleId) ||
        retained.has(ruleId),
    );
    return scripts.postprocess([messages, ...blocks], filename);
  },
};

export default [
  ...base,
  ...astroPreset,
  {
    files: astroFiles,
    processor,
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    rules: componentRules,
  },
  {
    files: scriptFiles,
    languageOptions: { parser: scripts.parser },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-undef": "error",
      ...(process.env.SCAFFOLDING_LINT_UNTYPED ? {} : typedRules),
    },
  },
  prettier,
];
