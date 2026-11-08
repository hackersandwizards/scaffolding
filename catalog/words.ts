// A story's file name and its states' export names as words, free of Node and Astro imports.

// A camelCase name reads in sentence case, "PrimaryOnNight" as "Primary on night", an acronym, a
// plural one ("PDFs") and a name with inner capitals from the list ("GitHub") whole. A name with
// underscores keeps each word in its author's case, "Angebot_ohne_Preise" as "Angebot ohne Preise".
// Either way the first word is capitalised.
const WORD =
  /(?:GitHub|GitLab|LinkedIn|YouTube|JavaScript|TypeScript|OpenAI)(?!\p{Ll})|\p{Lu}{2,}s(?!\p{Ll})|\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{N}+/gu;

/** The name's words, the first capitalised. */
export function wordsOf(name: string): string[] {
  const [first, ...rest] = name.match(WORD) ?? [name];
  return [first[0].toUpperCase() + first.slice(1), ...rest];
}

/** The name as it reads: "GridSlide" as "Grid slide". */
export function label(name: string): string {
  const sentence = !name.includes("_");
  return wordsOf(name)
    .map((w, i) => (i && sentence && /^\p{Lu}?\p{Ll}+$/u.test(w) ? w.toLowerCase() : w))
    .join(" ");
}
