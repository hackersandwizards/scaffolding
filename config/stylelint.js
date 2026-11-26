import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import postcssHtml from "postcss-html";
import unknownProperties from "stylelint-value-no-unknown-custom-properties";
import { submodulePaths } from "./submodules.js";

// A self-closing <style set:html={…} /> holds no CSS of its own and is blanked first, its line
// breaks kept: postcss-html would read the rest of the file as CSS. An attribute may hold ">".
const blank = (source) =>
  String(source).replace(/<style(?=[\s/>])(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^>"'{])*\/>/g, (tag) =>
    tag.replace(/[^\n]/g, " "),
  );
const astro = {
  parse: (source, options) => postcssHtml.parse(blank(source), options),
  stringify: postcssHtml.stringify,
};

const recommended = fileURLToPath(import.meta.resolve("stylelint-config-recommended"));
const brand = "@hackersandwizards/brand";

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
    plugins: [unknownProperties],
    ignoreFiles: submodulePaths(root).map((path) => `${path}/**`),
    overrides: [{ files: ["**/*.astro"], customSyntax: astro }],
    rules: {
      "selector-pseudo-class-no-unknown": [true, { ignorePseudoClasses: ["global"] }],
      "at-rule-no-unknown": [
        true,
        {
          ignoreAtRules: [
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
          ],
        },
      ],
      "csstools/value-no-unknown-custom-properties": tokens.length
        ? [true, { importFrom: tokens.map(at) }]
        : null,
    },
  };
}
