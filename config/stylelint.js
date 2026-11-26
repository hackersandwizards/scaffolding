import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import postcssHtml from "postcss-html";
import stylelint from "stylelint";
import unknownProperties from "stylelint-value-no-unknown-custom-properties";
import { submodulePaths } from "./submodules.js";

// postcss-html reads past self-closing style tags and parses empty set:html bodies as empty CSS.
const styleTagContent = /(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^>"'{])/.source;
const setHtmlAttribute = /(?<!=\s*)\sset:html(?=[\s=/>])/.source;
const emptyStyle = new RegExp(
  String.raw`<style(?=[\s/>])(?:${styleTagContent}*/>|${styleTagContent}*?${setHtmlAttribute}${styleTagContent}*>\s*</style\s*>)`,
  "g",
);
const blank = (source) => String(source).replace(emptyStyle, (tag) => tag.replace(/[^\r\n]/g, " "));
const astro = {
  parse: (source, options) => postcssHtml.parse(blank(source), options),
  stringify: postcssHtml.stringify,
};

const recommended = fileURLToPath(import.meta.resolve("stylelint-config-recommended"));
const brand = "@hackersandwizards/brand";
const tailwindAtRules = [
  "tailwind",
  "theme",
  "source",
  "utility",
  "variant",
  "custom-variant",
  "apply",
  "reference",
  "config",
  "plugin",
];
const importPositionRule = "no-invalid-position-at-import-rule";
const scopedImportPositionRule = `scaffolding/${importPositionRule}`;
const duplicatePropertyRule = "declaration-block-no-duplicate-custom-properties";
const scopedDuplicatePropertyRule = `scaffolding/${duplicatePropertyRule}`;
const declarationValueRule = "declaration-property-value-no-unknown";
const scopedDeclarationValueRule = `scaffolding/${declarationValueRule}`;
const tailwindImport = /^(["'])tailwindcss\1/;
const hasTailwindImport = (root) =>
  root.walkAtRules("import", ({ params }) => !tailwindImport.test(params)) === false;
const importPosition = stylelint.createPlugin(
  scopedImportPositionRule,
  (primary, secondary, context) => async (root, result) => {
    if (hasTailwindImport(root)) return;
    const check = (await stylelint.rules[importPositionRule])(primary, secondary, context);
    return check(root, result);
  },
);
const duplicateProperties = stylelint.createPlugin(
  scopedDuplicatePropertyRule,
  (primary, secondary, context) => async (root, result) => {
    const check = (await stylelint.rules[duplicatePropertyRule])(primary, secondary, context);
    if (!hasTailwindImport(root)) return check(root, result);

    const filtered = root.clone();
    filtered.walkDecls((decl) => {
      if (decl.parent.type === "atrule" && decl.parent.name === "utility") decl.remove();
    });
    return check(filtered, result);
  },
);

const usesVar = (decl) => /\bvar\(/i.test(decl.raws.value?.raw ?? decl.value);

function checkScopedDeclarationValues(root, result, check) {
  const file = root.clone();
  const registrations = new Set();
  file.walkAtRules(/^property$/i, (rule) => {
    registrations.add(rule);
  });

  const blocks = new Map();
  file.walkDecls((decl) => {
    if (usesVar(decl) && !registrations.has(decl.parent)) blocks.set(decl.parent, []);
  });
  file.walkDecls((decl) => {
    const declarations = blocks.get(decl.parent);
    if (declarations) declarations.push(decl.remove());
  });
  check(file, result);

  const { postcss } = result.stylelint;
  for (const [block, declarations] of blocks) {
    let nodes = declarations;
    for (let parent = block; parent.type !== "root"; parent = parent.parent) {
      const { source, raws, name, params, selector } = parent;
      nodes = [
        parent.type === "atrule"
          ? postcss.atRule({ source, raws, name, params, nodes })
          : postcss.rule({ source, raws, selector, nodes }),
      ];
    }
    const scope = postcss.root({ source: root.source });
    scope.append(
      [...registrations].map((rule) => rule.clone()),
      nodes,
    );
    check(scope, result);
  }
}

const declarationValues = stylelint.createPlugin(
  scopedDeclarationValueRule,
  (primary, secondary, context) => async (root, result) => {
    const check = (await stylelint.rules[declarationValueRule])(primary, secondary, context);
    const hasAssignments = root.walkDecls(/^--/, () => false) === false;
    const hasReferences = root.walkDecls((decl) => !usesVar(decl)) === false;
    if (!hasAssignments || !hasReferences) return check(root, result);
    checkScopedDeclarationValues(root, result, check);
  },
);

export default function styles({ importFrom = [] } = {}) {
  const root = process.cwd();
  const resolve = createRequire(join(root, "package.json")).resolve;
  const at = (file) =>
    isAbsolute(file)
      ? file
      : file.startsWith(".") || !file.includes("/")
        ? join(root, file)
        : resolve(file);
  const manifest = join(root, "package.json");
  const pkg = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : {};
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  const tokens =
    pkg.name === brand || Object.hasOwn(declared, brand)
      ? [`${brand}/tokens.root.css`, ...importFrom]
      : importFrom;
  return {
    extends: [recommended],
    plugins: [unknownProperties, importPosition, duplicateProperties, declarationValues],
    ignoreFiles: submodulePaths(root).map((path) => `${path}/**`),
    overrides: [
      {
        files: ["**/*.astro"],
        customSyntax: astro,
        // postcss-html parses style attribute declarations without a surrounding CSS rule.
        rules: { "no-invalid-position-declaration": null },
      },
    ],
    rules: {
      "selector-pseudo-class-no-unknown": [true, { ignorePseudoClasses: ["global"] }],
      "at-rule-no-unknown": [true, { ignoreAtRules: tailwindAtRules }],
      "at-rule-prelude-no-invalid": [true, { ignoreAtRules: tailwindAtRules }],
      [importPositionRule]: null,
      [scopedImportPositionRule]: true,
      [duplicatePropertyRule]: null,
      [scopedDuplicatePropertyRule]: true,
      [declarationValueRule]: null,
      [scopedDeclarationValueRule]: true,
      "csstools/value-no-unknown-custom-properties": tokens.length
        ? [true, { importFrom: tokens.map(at) }]
        : null,
    },
  };
}
