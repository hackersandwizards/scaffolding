// The stylelint base every repository shares: a stylesheet reads only custom properties that
// brand's tokens or the repository itself define, so no repository reads a property brand does not
// have. A repository's stylelint.config.js names its own definitions, as files or package
// specifiers (resolved through the package's exports), and may spread more rules on top:
//
//   import styles from "@hackersandwizards/scaffolding/stylelint";
//   export default styles({ importFrom: ["src/styles/own.css", "@hackersandwizards/brand/expert.css"] });
//
// Brand's tokens are read from the repository's installed brand; without it the config throws.
// The <style> blocks of Astro components are read too (postcss-html), so a property written in a
// component meets the same rule as one in a stylesheet. A self-closing <style set:html={…} /> holds
// no CSS of its own and is blanked first: postcss-html would read the rest of the file as CSS.
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import postcssHtml from "postcss-html";
import unknownProperties from "stylelint-value-no-unknown-custom-properties";

const blank = (source) =>
  String(source).replace(/<style\b[^>]*\/>/g, (tag) => " ".repeat(tag.length));
const astro = {
  parse: (source, options) => postcssHtml.parse(blank(source), options),
  stringify: postcssHtml.stringify,
};

export default function styles({ importFrom = [] } = {}) {
  const root = process.cwd();
  const resolve = createRequire(join(root, "package.json")).resolve;
  const at = (file) =>
    isAbsolute(file)
      ? file
      : file.startsWith(".") || !file.includes("/")
        ? join(root, file)
        : resolve(file);
  return {
    plugins: [unknownProperties],
    overrides: [{ files: ["**/*.astro"], customSyntax: astro }],
    rules: {
      "csstools/value-no-unknown-custom-properties": [
        true,
        { importFrom: ["@hackersandwizards/brand/tokens.root.css", ...importFrom].map(at) },
      ],
    },
  };
}
