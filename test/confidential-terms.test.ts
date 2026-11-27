import { expect, test } from "vitest";
import {
  collectPublishedGrams,
  ConfidentialTermMatcher,
  createTermHasher,
  DAY,
  describeStaleCacheWarning,
  extractNestedStrings,
  findShortNeverNames,
  HOUR,
  isCachedListStale,
  isCapitalisedWord,
  isNeverCacheStale,
  neverBadTermSet,
  neverPathFinding,
  neverTermFinding,
  parseNeverInput,
  parseTermLines,
  publicBadTermSet,
  publicPathFinding,
  publicTermFinding,
  splitPipedTermLists,
  stripPackageAllowTargets,
  TermVariantHasher,
  termVariants,
  tokenizeConfidentialWords,
  validateTermListBuildTime,
} from "../lib/confidential-terms.ts";

test("createTermHasher returns a 32-hex salted sha256 digest", () => {
  const hashA = createTermHasher("salt-a");
  const hashB = createTermHasher("salt-b");
  expect(hashA("acme")).toMatch(/^[0-9a-f]{32}$/);
  expect(hashA("acme")).toBe(hashA("acme"));
  expect(hashA("acme")).not.toBe(hashB("acme"));
});

test.each([
  { input: "Cafe\u0301 & Co.", expected: ["Café", "Co"] },
  { input: "alpha_beta-99", expected: ["alpha", "beta", "99"] },
  { input: "---", expected: [] },
])("tokenizeConfidentialWords($input)", ({ input, expected }) => {
  expect(tokenizeConfidentialWords(input)).toEqual(expected);
});

test.each([
  { word: "QUUX", expected: true },
  { word: "K2", expected: true },
  { word: "Quux", expected: false },
  { word: "Q", expected: false },
])("isCapitalisedWord($word) is $expected", ({ word, expected }) => {
  expect(isCapitalisedWord(word)).toBe(expected);
});

test.each([
  { stdin: "alpha\nbeta\0gamma", expected: ["alpha\nbeta", "gamma"] },
  { stdin: "alpha\nbeta", expected: ["alpha\nbeta", ""] },
])("splitPipedTermLists splits on NUL", ({ stdin, expected }) => {
  expect(splitPipedTermLists(stdin)).toEqual(expected);
});

test.each([
  { raw: "  Alpha \n\n Beta  \n", expected: ["Alpha", "Beta"] },
  { raw: "\n   \n", expected: [] },
])("parseTermLines trims and drops blanks", ({ raw, expected }) => {
  expect(parseTermLines(raw)).toEqual(expected);
});

test.each([
  { term: "Zetacorp GmbH", expected: ["Zetacorp GmbH", "Zetacorp"] },
  { term: "Zetacorp GmbH & Co. KG", expected: ["Zetacorp GmbH & Co. KG", "Zetacorp"] },
  { term: "Zetacorp", expected: ["Zetacorp"] },
])("termVariants($term)", ({ term, expected }) => {
  expect(termVariants(term)).toEqual(expected);
});

test.each([
  { names: ["AB GmbH", "Zetacorp"], expected: ["AB GmbH"] },
  { names: ["ABC", "Zetacorp AG"], expected: [] },
])("findShortNeverNames finds sub-3-letter stripped names", ({ names, expected }) => {
  expect(findShortNeverNames(names)).toEqual(expected);
});

test("collectPublishedGrams builds 1-to-6 word lowercased grams", () => {
  const grams = collectPublishedGrams("One Two Three Four Five Six Seven");
  expect(grams.has("one")).toBe(true);
  expect(grams.has("one two three four five six")).toBe(true);
  expect(grams.has("one two three four five six seven")).toBe(false);
});

test("TermVariantHasher hashes public terms and never names with dictionary and published filtering", () => {
  const salt = "0123456789abcdef";
  const dict = new Set(["apple", "banana"]);
  const hasher = new TermVariantHasher(salt, dict);
  const published = collectPublishedGrams("Public Partner");
  const pub = hasher.hashPublicTerms(
    ["Apple", "QUUX", "Public Partner", "Xylophon GmbH"],
    published,
  );
  const hash = createTermHasher(salt);
  expect(pub.maxTokens).toBe(2);
  expect(pub.hashes).toEqual([hash("cs:QUUX"), hash("xylophon"), hash("xylophon gmbh")].sort());

  const nev = hasher.hashNeverNames(["Apple", "QUUX"]);
  expect(nev.hashes).toEqual([hash("any:apple"), hash("cs:QUUX"), hash("any:quux")].sort());
});

test("stripPackageAllowTargets drops allow text and path while keeping reasons", () => {
  const output = stripPackageAllowTargets({
    name: "demo",
    scaffolding: {
      allow: [
        { check: "confidential", path: "docs/a.md", text: "Zetacorp", reason: "public example" },
      ],
    },
  });
  expect(JSON.parse(output)).toEqual({
    name: "demo",
    scaffolding: {
      allow: [{ check: "confidential", reason: "public example" }],
    },
  });
});

test.each([
  { age: DAY - 1, expected: false },
  { age: DAY, expected: true },
])("isCachedListStale($age) is $expected", ({ age, expected }) => {
  expect(isCachedListStale(age)).toBe(expected);
});

test.each([
  { age: 1000, list: { salt: "s", maxTokens: 1, hashes: [], never: ["h"] }, expected: false },
  { age: 1000, list: { salt: "s", maxTokens: 1, hashes: [] }, expected: true },
  { age: DAY, list: { salt: "s", maxTokens: 1, hashes: [], never: ["h"] }, expected: true },
])("isNeverCacheStale checks age and never section", ({ age, list, expected }) => {
  expect(isNeverCacheStale(age, list)).toBe(expected);
});

test.each([
  {
    hasCache: false,
    age: Infinity,
    expected: "no copy; next fetch within the hour, or now by `check-confidential fetch`",
  },
  {
    hasCache: true,
    age: DAY,
    expected: "copy older than a day; next fetch within the hour",
  },
  {
    hasCache: true,
    age: 1000,
    expected: "copy without a never section; next fetch within the hour",
  },
])("describeStaleCacheWarning($hasCache, $age)", ({ hasCache, age, expected }) => {
  expect(describeStaleCacheWarning(hasCache, age)).toBe(expected);
});

test.each<{
  label: string;
  built: string | undefined;
  expected: { problem?: string; warning?: string };
}>([
  { label: "fresh", built: new Date(10 * DAY).toISOString(), expected: {} },
  {
    label: "missing",
    built: undefined,
    expected: {
      problem:
        "/cache/list.json has an invalid built timestamp, so the scan cannot tell whether the list is current. To refresh the list, run `gh auth login` with an account in the hackersandwizards trainers team, then run `check-confidential fetch`.",
    },
  },
  {
    label: "future",
    built: new Date(10 * DAY + HOUR + 1000).toISOString(),
    expected: {
      problem:
        "/cache/list.json has an invalid built timestamp, so the scan cannot tell whether the list is current. To refresh the list, run `gh auth login` with an account in the hackersandwizards trainers team, then run `check-confidential fetch`.",
    },
  },
  {
    label: "warn 4d",
    built: new Date(6 * DAY - 1000).toISOString(),
    expected: { warning: "list built 4 days ago; Company OS has not rebuilt it" },
  },
  {
    label: "expired 8d",
    built: new Date(2 * DAY - 1000).toISOString(),
    expected: {
      problem:
        "The list at /cache/list.json was built 8 days ago and is too old to scan with. To refresh the list, run `gh auth login` with an account in the hackersandwizards trainers team, then run `check-confidential fetch`.",
    },
  },
])("validateTermListBuildTime: $label", ({ built, expected }) => {
  const list = { built, salt: "s", maxTokens: 1, hashes: [] };
  expect(validateTermListBuildTime(list, "/cache/list.json", 10 * DAY)).toEqual(expected);
});

test("publicBadTermSet and neverBadTermSet select the right hash sets", () => {
  const list = { salt: "s", maxTokens: 1, hashes: ["p1"], never: ["n1"] };
  expect([...publicBadTermSet(list)]).toEqual(["p1", "n1"]);
  expect([...neverBadTermSet(list)]).toEqual(["n1"]);
});

test("ConfidentialTermMatcher matches cased, grams, capital pairs, slugs, and never any-case in order", () => {
  const salt = "abcd";
  const hash = createTermHasher(salt);
  const pubBad = new Set([hash("cs:QUUX"), hash("k 2"), hash("north star"), hash("cs:ACME")]);
  const pubMatcher = new ConfidentialTermMatcher(salt, 3, pubBad);
  expect([
    ...pubMatcher.matchPublicTexts(["See QUUX, K 2, k 2, North Star, and clients/acme-demo"]),
  ]).toEqual(["QUUX", "K 2", "North Star", "acme"]);

  const nevBad = new Set([hash("any:apple"), hash("apple pie")]);
  const nevMatcher = new ConfidentialTermMatcher(salt, 3, nevBad);
  expect([...nevMatcher.matchNeverTexts(["Apple pie"])]).toEqual(["Apple", "Apple pie"]);
});

test("publicTermFinding, publicPathFinding, and neverTermFinding build expected finding shapes", () => {
  expect(publicTermFinding("a.ts", "QUUX")).toEqual({
    check: "confidential",
    path: "a.ts",
    text: "QUUX",
    message:
      "confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow",
    term: true,
  });
  expect(publicPathFinding("quux.ts", "quux")).toEqual({
    check: "confidential",
    path: "quux.ts",
    text: "quux",
    message:
      "confidential term from the company records in the file's path: rename the file to a generic or fictitious name. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow",
    term: true,
    name: true,
  });
  expect(neverTermFinding("deck", "Zetacorp")).toEqual({
    check: "never-shown",
    path: "deck",
    text: "Zetacorp",
    message:
      "a name h&w never shows from the company records: remove or anonymise the name with a generic or fictitious placeholder.",
    term: true,
  });
});

test("neverPathFinding uses path wording and marks name true", () => {
  expect(neverPathFinding("zetacorp-deck.md", "zetacorp")).toEqual({
    check: "never-shown",
    path: "zetacorp-deck.md",
    text: "zetacorp",
    message:
      "a name h&w never shows from the company records in the file's path: rename the file to a generic or fictitious name.",
    term: true,
    name: true,
  });
});

test.each([
  { value: "plain", expected: ["plain"] },
  { value: { title: "hello", items: ["one", 2] }, expected: ["title", "hello", "items", "one"] },
  { value: 42, expected: [] },
])("extractNestedStrings($value)", ({ value, expected }) => {
  expect(extractNestedStrings(value)).toEqual(expected);
});

test.each<{
  label: string;
  raw: string;
  expected: (readonly [string, string[]])[] | undefined;
}>([
  {
    label: "valid nested",
    raw: '{"slide-1":{"heading":"Hello"}}',
    expected: [["slide-1", ["heading", "Hello"]]],
  },
  { label: "invalid json", raw: "{", expected: undefined },
  { label: "array root", raw: '["a"]', expected: undefined },
  { label: "empty value", raw: '{"slide-1":[]}', expected: undefined },
])("parseNeverInput: $label", ({ raw, expected }) => {
  expect(parseNeverInput(raw)).toEqual(expected);
});
