import js from "@eslint/js";
import astro from "eslint-plugin-astro";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";
import { frontmatterBlock, frontmatterFiles } from "./eslint-astro-frontmatter.js";
import { astroClientScript, astroTypePrograms } from "./eslint-astro-script.js";
import base, { scaffoldingPlugin } from "./eslint.js";
import oxlint from "./oxlint.json" with { type: "json" };

const astroFiles = ["**/*.astro"];
const scriptFiles = ["**/*.astro/*.ts"];
const astroPreset = astro.configs.recommended;
const astroParser = astroPreset.find((config) => config.name === "astro/base").languageOptions
  .parser;
const originalProcessor = astro.processors["client-side-ts"];
const scripts = astroTypePrograms(originalProcessor, astroParser);
const untyped = Boolean(process.env.SCAFFOLDING_LINT_UNTYPED);
const componentRegions = new Map();
const retained = new Set(["no-dupe-args", "no-octal", "no-undef", "no-useless-assignment"]);
const componentRules = {
  ...js.configs.recommended.rules,
  ...tseslint.configs.recommended.find((config) => config.name === "typescript-eslint/recommended")
    .rules,
  "no-empty": oxlint.rules["no-empty"],
  eqeqeq: oxlint.rules.eqeqeq,
  "no-var": oxlint.rules["no-var"],
  "prefer-const": oxlint.rules["prefer-const"],
  "no-warning-comments": oxlint.rules["no-warning-comments"],
  "@typescript-eslint/no-unused-vars": "off",
};
const typedRules = Object.fromEntries(
  Object.keys(
    oxlint.overrides.find(({ rules }) => Object.hasOwn(rules, "typescript/no-floating-promises"))
      .rules,
  ).map((rule) => [rule.replace("typescript/", "@typescript-eslint/"), "error"]),
);

function reportsInOxlintRegion(ruleId) {
  return !Object.hasOwn(componentRules, ruleId) || retained.has(ruleId);
}

export function javascriptScriptRange(node) {
  if (node.openingElement.end >= node.closingElement.start) return;
  const type = node.openingElement.attributes.find(
    (attr) => typeof attr.name?.name === "string" && attr.name.name.toLowerCase() === "type",
  )?.value;
  if (
    type &&
    (type.type !== "Literal" ||
      !/^(?:module|(?:text|application)\/(?:java|ecma)script)?$/i.test(
        String(type.value).split(";")[0].trim(),
      ))
  )
    return;
  return [node.openingElement.end, node.closingElement.start];
}

function oxlintRegions(code, template) {
  const ranges = [];
  const scripts = new Set();
  let index = 0;
  // Oxlint takes the raw text between the fences, including whitespace on the opening line.
  const fences = code.matchAll(/(?:^|\n)[^\S\n]*---(?=[^\S\n]*(?:\n|$))/g);
  const opening = fences.next().value;
  if (opening && !code.slice(0, opening.index).trim()) {
    const closing = fences.next().value;
    if (closing)
      ranges.push([opening.index + opening[0].length, closing.index + closing[0].length - 3]);
  }
  template.walk(template.result.ast, (node) => {
    if (
      node.type !== "JSXElement" ||
      node.openingElement.name.name !== "script" ||
      !node.closingElement
    )
      return;
    const extracted = astroClientScript(node) ? ++index : undefined;
    const range = javascriptScriptRange(node);
    if (!range) return;
    ranges.push(range);
    if (extracted !== undefined) scripts.add(extracted);
  });
  return {
    scripts,
    ranges: ranges.map((range) => range.map((offset) => template.getLocFromIndex(offset))),
  };
}

function inRegion({ line, column }, [start, end]) {
  return (
    (line > start.line || (line === start.line && column - 1 >= start.column)) &&
    (line < end.line || (line === end.line && column - 1 < end.column))
  );
}

const processor = {
  meta: { ...originalProcessor.meta, name: "scaffolding/astro" },
  supportsAutofix: true,
  frontmatterBlock,
  reportsInOxlintRegion,
  oxlintRegions(filename) {
    return componentRegions.get(filename);
  },
  preprocess(code, filename) {
    try {
      componentRegions.set(filename, oxlintRegions(code, astroParser.parseTemplate(code)));
    } catch {
      // The Astro parser reports the syntax error itself.
      componentRegions.delete(filename);
    }
    return scripts.preprocess(code, filename);
  },
  postprocess([component, ...blocks], filename) {
    const regions = componentRegions.get(filename);
    componentRegions.delete(filename);
    // Component rules can inspect raw text in script tags as well as the component AST.
    const messages = component.filter(
      (message) =>
        reportsInOxlintRegion(message.ruleId) ||
        !regions?.ranges.some((range) => inRegion(message, range)),
    );
    return scripts.postprocess([messages, ...blocks], filename);
  },
};

export default [
  ...[...base, ...astroPreset].map((config) =>
    config.rules
      ? { ...config, ignores: [...(config.ignores ?? []), ...frontmatterFiles] }
      : config,
  ),
  {
    files: astroFiles,
    plugins: { scaffolding: scaffoldingPlugin },
    processor,
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    rules: {
      ...componentRules,
      "scaffolding/no-catch-fallback": "error",
      "scaffolding/no-empty-catch": "error",
      "scaffolding/no-lint-disable": "error",
    },
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
      ...(untyped ? {} : typedRules),
    },
  },
  ...(untyped
    ? []
    : [
        {
          files: frontmatterFiles,
          languageOptions: { parser: scripts.parser },
          rules: typedRules,
        },
      ]),
  prettier,
];
