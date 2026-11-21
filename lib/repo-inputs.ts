/** Whether a Git dependency's URL names a repository hackersandwizards owns, on any host and in
 * https, ssh or scp form, its #ref aside: a package of ours need not carry our scope. */
export const ourRepository = (url: string) =>
  /[/:]hackersandwizards\/[^/#]+$/.test(url.replace(/#.*/, ""));

/** SCAFFOLDING_FETCH_WAIT_S, the seconds a read from a remote may take: 20 unless it is a whole
 * number above 0, as in session-start, and at most the longest timer (2^31 - 1 ms), past which a
 * timeout fires at once. */
export const fetchWaitS = (): number => {
  const set = process.env.SCAFFOLDING_FETCH_WAIT_S ?? "";
  return /^\d*[1-9]\d*$/.test(set) ? Math.min(Number(set), Math.floor((2 ** 31 - 1) / 1000)) : 20;
};

/** A file's comments, by its kind: `#` lines for shell, Python, YAML, TOML, Git hooks and the
 * editor and Prettier ignore files, else block, HTML and `//` comments, a `//` in a URL or a
 * string's start excepted. A block comment opens only after a character that ends code or another
 * comment, or after a word when a space follows the mark: a glob such as "src/*.ts" would read on
 * to the next closing mark. Group 1 is what a replacement keeps: the character before a comment,
 * or, outside Markdown, HTML and templates, whose apostrophes are prose, a quoted string on one line, matched
 * as itself so that "x//y" or "issue #12" no longer dropped the code after it as a comment. */
export const commentSyntax = (path: string) => {
  const quoted = /\.(?:md|mdx|html?|astro|[jt]sx|vue|svelte)$/.test(path)
    ? ""
    : String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`;
  // After a string, the lookbehind ends the match at its closing quote.
  return /\.(?:sh|py|ya?ml|toml)$|(?:^|\/)(?:\.githooks\/[^/.]+|\.editorconfig|\.prettierignore)$/.test(
    path,
  )
    ? new RegExp(String.raw`(${quoted}^|\s)(?:(?<=["'])|#.*)`, "gm")
    : new RegExp(
        String.raw`(${quoted}^|[\s{};,)>]|\b(?=\/\*\s)|(?<=\*\/))(?:(?<=["'])|\/\*[\s\S]*?\*\/)|<!--[\s\S]*?-->|(?<![:"'` +
          "`" +
          String.raw`\\])\/\/.*`,
        "gm",
      );
};

/** Every file path an `exports` value names, a conditional export's included. */
export const exportTargets = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(exportTargets)
      : [];

export const styleFiles = "**/*.{css,astro}";
const styleGlob = new Bun.Glob(styleFiles);
// The gate's glob skips dot folders, dot files and node_modules; a staged path is named explicitly.
export const styled = (path: string) =>
  styleGlob.match(path) && !/(^|\/)(\.|node_modules\/)/.test(path);
