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
/** The line without its expressions, innermost first: the attributes of a tag inside one nest. */
const withoutExpressions = (line: string) => {
  let text = line;
  for (let inner; (inner = text.replace(/\{[^{}]*\}/g, "")) !== text;) text = inner;
  return text;
};
const holdsWords = (line: string) => {
  const text = withoutExpressions(line);
  // A brace left over closes an expression an earlier line opened.
  return !text.includes("}") && /[\p{L}\p{N}]/u.test(text.replace(/<[^>]*>/g, ""));
};
const endsInExpression = /(?<!\{\s*(?:" "|' ')\s*)\}\s*$/;
// A line of one expression that closes on it and whose first element is inline: jsx drops the break
// before it as it drops every whitespace-only text node. Mostly it lays out a sibling, so it counts
// only where the package's own pages keep the break and a consumer's jsx drops a space its author saw.
const firstTag = /<([a-z][\w-]*)/;
const inline = new RegExp(`^(?:${INLINE})$`);
const drawsInline = (line: string) => {
  const tag = line.match(firstTag)?.[1];
  return /^\s*\{/.test(line) && withoutExpressions(line).trim() === "" && tag && inline.test(tag)
    ? tag
    : undefined;
};
// A word, opening punctuation, a dash, or an expression that draws no element and closes on the
// line (one level of braces inside), alone or before text or an inline tag.
const startsInText = new RegExp(
  `^\\s*(?:[\\p{L}\\p{N}(["'“‘—–-]|\\{(?!\\s*(?:" "|' ')\\s*\\})(?:[^<{}]|\\{[^<{}]*\\})*\\}\\s*(?:$|[^\\s<{]|${inlineTag}))`,
  "u",
);

/** The template's lines, with frontmatter, comments (a // line in an expression too) and every
 * element whose line breaks are not template whitespace (script, style, pre, textarea) blanked. */
export function spaceTemplateLines(text: string): string[] {
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

export function lostSpaceTag(line: string, next: string, previous: string, kept: boolean) {
  // Prettier wraps a closing tag before its > where the line runs out.
  const closing = /^\s*>\s*$/.test(line) ? `${previous}>` : line;
  return (
    ((endsInText.test(line) || (endsInExpression.test(line) && holdsWords(line))) &&
      (next.match(opens)?.[1] || (kept && drawsInline(next)))) ||
    ((startsInText.test(next) || (kept && drawsInline(next))) && closing.match(closes)?.[1])
  );
}
