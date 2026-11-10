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
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest];
}

/** The name as it reads: "GridSlide" as "Grid slide". */
export function label(name: string, words = wordsOf(name)): string {
  const sentence = !name.includes("_");
  return words
    .map((w, i) => (i && sentence && /^\p{Lu}?\p{Ll}+$/u.test(w) ? w.toLowerCase() : w))
    .join(" ");
}

/** A page's title: on a state's page and a state alone "<component>: <state> – <catalog>", so each
 * reads apart in a search result or a tab; elsewhere the catalog's. */
export function pageTitle(
  modules: { name: string; stories: { id: string; name: string }[] }[],
  story: string | undefined,
  catalog: string,
): string {
  for (const m of modules) {
    const state = m.stories.find((s) => s.id === story);
    if (state) return `${label(m.name)}: ${label(state.name)} – ${catalog}`;
  }
  return catalog;
}
