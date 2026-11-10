import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import postcssHtml from "postcss-html";
import unknownProperties from "stylelint-value-no-unknown-custom-properties";

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
