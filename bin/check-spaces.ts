#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
// Astro's default compressHTML drops a line break where text meets an inline tag, so "drawn by" on
// one line and "<code>brand</code>" on the next render as "drawn bybrand". Prettier writes {" "}
// where a space is meant; this finds the line breaks that still carry one. Where every Astro config
// turns compressHTML off, every break renders as written and the check passes.
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
} from "../lib/repo.ts";

// HTML's inline elements that sit in running text: compressHTML drops the break before each.
const INLINE =
  "a|abbr|b|bdi|bdo|button|cite|code|data|del|dfn|em|i|img|input|ins|kbd|label|mark|meter|output|progress|q|s|samp|select|small|span|strong|sub|sup|svg|time|u|var";
const opens = new RegExp(`^\\s*<(${INLINE})(?:[\\s>/]|$)`);
const closes = new RegExp(`</(${INLINE})>\\s*$`);
// Text: a line that ends in neither a tag (>), an opening bracket nor an operator (= & |), or ends
// in an expression after words of its own ("by {name}"). A line of expressions alone, like the
// close of a multi-line one, mostly lays out sibling elements, where a break needs no space.
const endsInText = /[^\s>}{([=&|]\s*$/;
const holdsWords = (line: string) =>
  !/^\s*\{/.test(line) && /[\p{L}\p{N}]/u.test(line.replace(/<[^>]*>|\{[^}]*\}/g, ""));
const endsInExpression = /(?<!\{\s*(?:" "|' ')\s*)\}\s*$/;
// A word, opening punctuation, a dash, or one expression on its line that draws no element.
const startsInText = /^\s*(?:[\p{L}\p{N}("'“‘—–-]|\{(?!\s*(?:" "|' ')\s*\})[^<]*\}\s*$)/u;

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

const started = performance.now();
const root = repoRoot();
const files = listFiles(root, false);
// The config names Astro looks for.
const configs = files.filter((f) => /(?:^|\/)astro\.config\.m?[jt]s$/.test(f));
const off = (config: string) =>
  /\bcompressHTML\s*:\s*false\b/.test(
    readFileSync(join(root, config), "utf8").replace(commentSyntax(config), "$1"),
  );
if (configs.length && configs.every(off)) finish("spaces", [], started);
const found: Finding[] = [];
for (const file of files.filter((f) => f.endsWith(".astro"))) {
  const lines = template(readFileSync(join(root, file), "utf8"));
  lines.forEach((line, i) => {
    const next = lines[i + 1] ?? "";
    // Prettier wraps a closing tag before its > where the line runs out.
    const closing = /^\s*>\s*$/.test(line) ? `${lines[i - 1]}>` : line;
    const tag =
      ((endsInText.test(line) || (endsInExpression.test(line) && holdsWords(line))) &&
        next.match(opens)?.[1]) ||
      (startsInText.test(next) && closing.match(closes)?.[1]);
    if (tag)
      found.push({
        check: "spaces",
        path: file,
        text: line.trim(),
        message: `line ${i + 1}: the line break before line ${i + 2} meets <${tag}> and compressHTML drops it; end the line in {" "} or join the lines`,
      });
  });
}
finish("spaces", applyAllow(readPackage(root), "spaces", found, true), started);
