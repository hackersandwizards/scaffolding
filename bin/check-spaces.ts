#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
// Astro's default compressHTML, "jsx", drops a line break where text meets an inline tag, so "drawn
// by" on one line and "<code>brand</code>" on the next render as "drawn bybrand". Prettier writes
// {" "} where a space is meant; this finds the line breaks that still carry one. compressHTML true
// and false keep the break as a space, so where every Astro config sets one of them the check reads
// only the components the package ships, which a consumer compiles under its own setting.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyAllow,
  commentSyntax,
  finish,
  listFiles,
  readPackage,
  repoRoot,
  type Finding,
  type Package,
} from "../lib/repo.ts";

// HTML's inline elements that sit in running text: the jsx mode drops the break before each.
const INLINE =
  "a|abbr|b|bdi|bdo|button|cite|code|data|del|dfn|em|i|img|input|ins|kbd|label|mark|meter|output|progress|q|s|samp|select|small|span|strong|sub|sup|svg|time|u|var";
// Its attributes may follow on the next line.
const inlineTag = `<(${INLINE})(?:[\\s>/]|$)`;
const opens = new RegExp(`^\\s*${inlineTag}`);
const closes = new RegExp(`</(${INLINE})>\\s*$`);
// Text: a line that ends in neither a tag (>), an opening bracket nor an operator (= & |), or ends
// in an expression after words of its own ("by {name}"). A line of expressions alone, like the
// close of a multi-line one, mostly lays out sibling elements, where a break needs no space.
const endsInText = /[^\s>}{([=&|]\s*$/;
const holdsWords = (line: string) => {
  let text = line;
  // Innermost braces first: the attributes of a tag inside an expression nest.
  for (let inner; (inner = text.replace(/\{[^{}]*\}/g, "")) !== text;) text = inner;
  // A brace left over closes an expression an earlier line opened.
  return !text.includes("}") && /[\p{L}\p{N}]/u.test(text.replace(/<[^>]*>/g, ""));
};
const endsInExpression = /(?<!\{\s*(?:" "|' ')\s*)\}\s*$/;
// A word, opening punctuation, a dash, or an expression that draws no element and closes on the
// line (one level of braces inside), alone or before text or an inline tag.
// An expression that closes on its line and draws an inline element: jsx drops the break before it
// as it drops every whitespace-only text node. Mostly it lays out a sibling, so it counts only where
// the package's own pages keep the break and a consumer's jsx drops a space its author saw.
const drawsInline = (line: string) => {
  let rest = line;
  for (let inner; (inner = rest.replace(/\{[^{}]*\}/g, "")) !== rest;) rest = inner;
  return /^\s*\{/.test(line) && rest.trim() === "" && new RegExp(inlineTag).test(line);
};
const startsInText = new RegExp(
  `^\\s*(?:[\\p{L}\\p{N}(["'“‘—–-]|\\{(?!\\s*(?:" "|' ')\\s*\\})(?:[^<{}]|\\{[^<{}]*\\})*\\}\\s*(?:$|[^\\s<{]|${inlineTag}))`,
  "u",
);

/** The template's lines, with frontmatter, comments (a // line in an expression too) and every
 * element whose line breaks are not template whitespace (script, style, pre, textarea) blanked. */
function template(text: string): string[] {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return (
    text
      .replace(/^---\r?\n(?:[\s\S]*?\n)?---/, blank)
      // An attribute may hold ">" (`set:html={a => b}`), and `<script ... />` closes itself.
      .replace(
        /<(script|style|pre|textarea)(?=[\s/>])(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^>"'{])*(?:\/>|>[\s\S]*?<\/\1>)/g,
        blank,
      )
      .replace(/<!--[\s\S]*?-->|\{\/\*[\s\S]*?\*\/\}|^\s*\/\/.*$/gm, blank)
      .split("\n")
  );
}

/** The paths `files` and `exports` of package.json name, as a test of a repository path. */
function shippedBy(pkg: Package) {
  const targets = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : value && typeof value === "object"
        ? Object.values(value).flatMap(targets)
        : [];
  const patterns = [...(Array.isArray(pkg.files) ? pkg.files : []), ...targets(pkg.exports)]
    .filter((p): p is string => typeof p === "string" && !p.startsWith("!"))
    .map((p) => p.replace(/^\.\//, "").replace(/\/$/, ""))
    .map(
      (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}(?:/|$)`),
    );
  return (path: string) => patterns.some((p) => p.test(path));
}

const started = performance.now();
const root = repoRoot();
const pkg = readPackage(root);
const files = listFiles(root, false);
// The config names Astro looks for.
const configs = files.filter((f) => /(?:^|\/)astro\.config\.m?[jt]s$/.test(f));
const keeps = (config: string) =>
  /\bcompressHTML\s*:\s*(?:false|true)\b/.test(
    readFileSync(join(root, config), "utf8").replace(commentSyntax(config), "$1"),
  );
const kept = configs.length > 0 && configs.every(keeps);
const reads = kept ? shippedBy(pkg) : () => true;
const found: Finding[] = [];
for (const file of files.filter((f) => f.endsWith(".astro") && reads(f))) {
  const lines = template(readFileSync(join(root, file), "utf8"));
  lines.forEach((line, i) => {
    const next = lines[i + 1] ?? "";
    // Prettier wraps a closing tag before its > where the line runs out.
    const closing = /^\s*>\s*$/.test(line) ? `${lines[i - 1]}>` : line;
    const tag =
      ((endsInText.test(line) || (endsInExpression.test(line) && holdsWords(line))) &&
        next.match(opens)?.[1]) ||
      ((startsInText.test(next) || (kept && drawsInline(next))) && closing.match(closes)?.[1]);
    if (tag)
      found.push({
        check: "spaces",
        path: file,
        text: line.trim(),
        message: `line ${i + 1}: the line break before line ${i + 2} meets <${tag}> and compressHTML "jsx" drops it; end the line in {" "} or join the lines`,
      });
  });
}
finish("spaces", applyAllow(pkg, "spaces", found, true), started);
