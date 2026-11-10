/** The shell's CSS with brand's value as the fallback of each var() that names a token in brand's
 * tokens.json, in place of any fallback the shell writes, the bare var()s inside that value filled
 * the same way. Inside brand's own values a fallback stays: it is brand's to write. */
export function brandFallbacks(
  css: string,
  tokens: Record<string, string>,
  seen: string[] = [],
): string {
  let out = "";
  let at = 0;
  for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
    const name = m[1]!;
    if (m.index < at || !Object.hasOwn(tokens, name) || seen.includes(name)) continue;
    let end = m.index + m[0].length;
    if (m[2] === ",") {
      if (seen.length) continue;
      for (let depth = 1; depth && end < css.length; end++)
        depth += css[end] === "(" ? 1 : css[end] === ")" ? -1 : 0;
    }
    out += `${css.slice(at, m.index)}var(${name}, ${brandFallbacks(tokens[name]!, tokens, [...seen, name])})`;
    at = end;
  }
  return out + css.slice(at);
}
