#!/usr/bin/env bun
// Astro's default compressHTML drops a line break where text meets an inline tag, so "drawn by" on
// one line and "<code>brand</code>" on the next render as "drawn bybrand". Prettier writes {" "}
// where a space is meant; this finds the line breaks that still carry one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyAllow, finish, listFiles, repoRoot, type Finding } from "../lib/repo.ts";

const INLINE = "a|code|span|strong|em|kbd";
const opens = new RegExp(`^\\s*<(${INLINE})(?:[\\s>]|$)`);
const closes = new RegExp(`</(${INLINE})>\\s*$`);
// Text: a line that ends in neither a tag (>), an expression (} or {" "}), an opening bracket nor
// an operator (= & |).
const endsInText = /[^\s>}{([=&|]\s*$/;
const startsWithWord = /^\s*[\p{L}\p{N}]/u;

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
const found: Finding[] = [];
for (const file of listFiles(root, false).filter((f) => f.endsWith(".astro"))) {
  const lines = template(readFileSync(join(root, file), "utf8"));
  lines.forEach((line, i) => {
    const next = lines[i + 1] ?? "";
    const tag =
      (endsInText.test(line) && next.match(opens)?.[1]) ||
      (startsWithWord.test(next) && line.match(closes)?.[1]);
    if (tag)
      found.push({
        check: "spaces",
        path: file,
        text: line.trim(),
        message: `line ${i + 1}: the line break before line ${i + 2} meets <${tag}> and compressHTML drops it; end the line in {" "} or join the lines`,
      });
  });
}
finish("spaces", applyAllow(root, "spaces", found, true), started);
