import { createHash } from "node:crypto";
import type { TermList } from "./confidential-input.ts";
import type { Finding, readPackage } from "./repo.ts";

export type RepoPackage = ReturnType<typeof readPackage>;

export const TERMS_REPO = "hackersandwizards/confidential-terms";
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

const LEGAL = /\s+(?:gmbh|ag|se|kg|ug|mbh|co|ltd|inc|llc|plc|bv|sa|sarl|gmbh & co\.? kg)\.?$/i;
const SLUG = /[\p{L}\p{N}]+(?:[-_/.][\p{L}\p{N}]+)+/gu;

export function createTermHasher(salt: string): (value: string) => string {
  return (value: string) =>
    createHash("sha256")
      .update(salt + value)
      .digest("hex")
      .slice(0, 32);
}

// NFKC first: macOS file names and some pasted text arrive decomposed, which splits words at accents.
export function tokenizeConfidentialWords(text: string): string[] {
  return text.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
}

// A one-word term written in capitals is a name in capitals (an acronym, a brand) and matches only
// in capitals, so a company called QUUX never flags an ordinary word "quux". Three-letter terms
// always do.
export function isCapitalisedWord(word: string): boolean {
  return /^\p{Lu}[\p{Lu}\p{N}]+$/u.test(word);
}

// One stdin carries both lists: the terms, a NUL byte, then the never names. Under `bun run` the
// command cannot open a fourth pipe (/dev/fd/3: EACCES, Bun 1.4.4).
export function splitPipedTermLists(stdin: string): [string, string] {
  const cut = stdin.includes("\0") ? stdin.indexOf("\0") : stdin.length;
  return [stdin.slice(0, cut), stdin.slice(cut + 1)];
}

export function parseTermLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// The scan reads grams of six words at most, so a longer term counts by its first six.
function firstSixWords(term: string): string[] {
  return tokenizeConfidentialWords(term).slice(0, 6);
}

function normalizeTerm(term: string): string {
  return firstSixWords(term).join(" ").toLowerCase();
}

export function termVariants(term: string): string[] {
  return LEGAL.test(term) ? [term, term.replace(LEGAL, "")] : [term];
}

// The names h&w never shows. An empty section would pass every deck, and a name under three
// letters, its legal form dropped, would match ordinary words.
export function findShortNeverNames(names: readonly string[]): string[] {
  return names.filter((term) =>
    termVariants(term).some((variant) => normalizeTerm(variant).replaceAll(" ", "").length < 3),
  );
}

export function collectPublishedGrams(text: string): Set<string> {
  const published = new Set<string>();
  const lowered = tokenizeConfidentialWords(text).map((word) => word.toLowerCase());
  for (let i = 0; i < lowered.length; i++) {
    for (
      let n = 1, gram = lowered[i];
      n <= 6 && i + n <= lowered.length;
      gram += ` ${lowered[i + n]}`, n++
    )
      published.add(gram);
  }
  return published;
}

export class TermVariantHasher {
  private readonly hash: (value: string) => string;
  private readonly dictionary: ReadonlySet<string>;

  constructor(salt: string, dictionary: ReadonlySet<string>) {
    this.hash = createTermHasher(salt);
    this.dictionary = dictionary;
  }

  /** The hash the public scans look up, none for a dictionary word, and the variant's casing. */
  hashVariant(variant: string): {
    normalized: string;
    tokenCount: number;
    hash?: string;
    anyCase: boolean;
  } {
    const tokens = firstSixWords(variant);
    const normalized = tokens.join(" ").toLowerCase();
    const one = tokens.length === 1;
    const cased = one && (normalized.length === 3 || isCapitalisedWord(tokens[0]));
    const word = one && normalized.length > 3 && this.dictionary.has(normalized) && !cased;
    return {
      normalized,
      tokenCount: tokens.length,
      hash: word ? undefined : this.hash(cased ? `cs:${tokens[0]}` : normalized),
      anyCase: cased || word,
    };
  }

  hashPublicTerms(
    terms: readonly string[],
    published: ReadonlySet<string>,
  ): { hashes: string[]; maxTokens: number } {
    const hashes = new Set<string>();
    let maxTokens = 1;
    for (const term of terms) {
      const variants = termVariants(term);
      if (variants.some((variant) => published.has(normalizeTerm(variant)))) continue;
      for (const variant of variants) {
        const result = this.hashVariant(variant);
        maxTokens = Math.max(maxTokens, result.tokenCount);
        if (result.normalized.length >= 3 && result.hash) hashes.add(result.hash);
      }
    }
    return { hashes: [...hashes].sort(), maxTokens };
  }

  // No public text drops a never name. A cased one or a dictionary word also gets a hash under
  // "any:", which only the never scan reads: a public scan keeps the rules above, and a deck still
  // refuses the name in any case.
  hashNeverNames(names: readonly string[]): { hashes: string[]; maxTokens: number } {
    const never = new Set<string>();
    let maxTokens = 1;
    for (const name of names) {
      for (const variant of termVariants(name)) {
        const result = this.hashVariant(variant);
        maxTokens = Math.max(maxTokens, result.tokenCount);
        if (result.hash) never.add(result.hash);
        if (result.anyCase) never.add(this.hash(`any:${result.normalized}`));
      }
    }
    return { hashes: [...never].sort(), maxTokens };
  }
}

// package.json's allow entries name the very terms and paths they allow, so the file is read without
// them, each entry's reason kept: whole, as the snapshot holds it, since its added lines alone cannot
// tell an entry from the rest.
export function stripPackageAllowTargets(pkg: RepoPackage): string {
  return JSON.stringify(
    {
      ...pkg,
      scaffolding: pkg.scaffolding && {
        ...pkg.scaffolding,
        allow: pkg.scaffolding.allow?.map(({ text: _t, path: _p, ...rest }) => rest),
      },
    },
    null,
    2,
  );
}

export function isCachedListStale(cacheAgeMs: number): boolean {
  return cacheAgeMs >= DAY;
}

// A copy fetched before Company OS built the never section is fetched again for the never scan.
export function isNeverCacheStale(cacheAgeMs: number, cachedList: TermList | undefined): boolean {
  return cacheAgeMs >= DAY || !cachedList?.never?.length;
}

export function describeStaleCacheWarning(hasCache: boolean, cacheAgeMs: number): string {
  if (!hasCache) return "no copy; next fetch within the hour, or now by `check-confidential fetch`";
  const reason = cacheAgeMs >= DAY ? "older than a day" : "without a never section";
  return `copy ${reason}; next fetch within the hour`;
}

export function validateTermListBuildTime(
  list: TermList,
  source: string,
  now: number,
): { problem?: string; warning?: string } {
  const built = Date.parse(list.built ?? "");
  if (Number.isNaN(built) || built > now + HOUR)
    return { problem: `${source} has no valid build time` };
  const days = (now - built) / DAY;
  if (days > 7) return { problem: `list built ${Math.floor(days)} days ago, more than 7` };
  if (days > 3)
    return { warning: `list built ${Math.floor(days)} days ago; Company OS has not rebuilt it` };
  return {};
}

// A public repository's own scans refuse a never name too, under their casing rule.
export function publicBadTermSet(list: TermList | undefined): Set<string> {
  return new Set([...(list?.hashes ?? []), ...(list?.never ?? [])]);
}

export function neverBadTermSet(list: TermList | undefined): Set<string> {
  return new Set(list?.never ?? []);
}

export class ConfidentialTermMatcher {
  private readonly hash: (value: string) => string;
  private readonly maxTokens: number;
  private readonly bad: ReadonlySet<string>;

  constructor(salt: string, maxTokens: number, bad: ReadonlySet<string>) {
    this.hash = createTermHasher(salt);
    this.maxTokens = maxTokens;
    this.bad = bad;
  }

  matchPublicTexts(texts: readonly string[]): Set<string> {
    const found = new Set<string>();
    for (const text of texts) {
      const tokens = tokenizeConfidentialWords(text);
      const lower = tokens.map((word) => word.toLowerCase());
      for (let i = 0; i < tokens.length; i++) {
        this.collectCasedToken(tokens[i], found);
        this.collectGramsAt(tokens, lower, i).forEach((hit) => found.add(hit));
      }
      this.collectSlugMatches(text, found);
    }
    return found;
  }

  matchNeverTexts(texts: readonly string[]): Set<string> {
    const found = new Set<string>();
    for (const text of texts) {
      const tokens = tokenizeConfidentialWords(text);
      const lower = tokens.map((word) => word.toLowerCase());
      for (let i = 0; i < tokens.length; i++) {
        this.collectCasedToken(tokens[i], found);
        if (this.bad.has(this.hash(`any:${lower[i]}`))) found.add(tokens[i]);
        this.collectGramsAt(tokens, lower, i).forEach((hit) => found.add(hit));
      }
      this.collectSlugMatches(text, found);
    }
    return found;
  }

  private collectCasedToken(token: string, found: Set<string>): void {
    if ((token.length === 3 || isCapitalisedWord(token)) && this.bad.has(this.hash(`cs:${token}`)))
      found.add(token);
  }

  private collectGramsAt(tokens: readonly string[], lower: readonly string[], start: number) {
    const hits: string[] = [];
    let gram = "";
    for (let n = 0; n < this.maxTokens && start + n < tokens.length; n++) {
      gram = n ? `${gram} ${lower[start + n]}` : lower[start];
      // One word of three letters is a cased term. Two one-character words ("K 2") count only
      // in capitals, since in lower case they are code (`c => a`).
      const pair = n === 1 && gram.length === 3;
      const counts = pair
        ? isCapitalisedWord(tokens[start] + tokens[start + 1])
        : n || gram.length > 3;
      if (counts && this.bad.has(this.hash(gram)))
        hits.push(tokens.slice(start, start + n + 1).join(" "));
    }
    return hits;
  }

  // A slug or path writes a capitalised name in lower case (quux-workshop, clients/quux/): a
  // lower-case part of a joined token is checked as the name in capitals.
  private collectSlugMatches(text: string, found: Set<string>): void {
    for (const [joined] of text.normalize("NFKC").matchAll(SLUG)) {
      for (const part of joined.split(/[-_/.]/)) {
        if (
          part.length >= 3 &&
          part === part.toLowerCase() &&
          this.bad.has(this.hash(`cs:${part.toUpperCase()}`))
        )
          found.add(part);
      }
    }
  }
}

export function publicTermFinding(where: string, term: string): Finding {
  return {
    check: "confidential",
    path: where,
    text: term,
    message:
      "confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow",
    term: true,
  };
}

export function publicPathFinding(where: string, term: string): Finding {
  return {
    check: "confidential",
    path: where,
    text: term,
    message:
      "confidential term from the company records in the file's path: rename the file to a generic or fictitious name. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow",
    term: true,
    name: true,
  };
}

export function neverTermFinding(where: string, term: string): Finding {
  return {
    check: "never-shown",
    path: where,
    text: term,
    message:
      "a name h&w never shows from the company records: remove or anonymise the name with a generic or fictitious placeholder.",
    term: true,
  };
}

export function neverPathFinding(where: string, term: string): Finding {
  return {
    check: "never-shown",
    path: where,
    text: term,
    message:
      "a name h&w never shows from the company records in the file's path: rename the file to a generic or fictitious name.",
    term: true,
    name: true,
  };
}

// A value may nest: its object keys and every string in it are its text, so a deck goes in whole.
export function extractNestedStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(Array.isArray(value) ? [] : [key]),
    ...extractNestedStrings(item),
  ]);
}

export function parseNeverInput(raw: string): (readonly [string, string[]])[] | undefined {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const texts = Object.entries(input).map(
    ([where, value]) => [where, extractNestedStrings(value)] as const,
  );
  if (!texts.length || texts.some(([, text]) => !text.length)) return undefined;
  return texts;
}
