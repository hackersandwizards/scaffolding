import { expect, test } from "vitest";
import { openingWhitespaceTag } from "../lib/astro-spaces.ts";
import { decodeEntity, parseTermList, validTermTokenLimit } from "../lib/confidential-input.ts";

test.each([["{", undefined]])("rejects the fixed malformed term list %j", (input, result) => {
  expect(parseTermList(input)).toBe(result);
});

test.each([[{ line: 'word {" "} {count}', next: "<var>", kept: false }, "var"]])(
  "treats words before adjacent expressions as an opening boundary",
  ({ line, next, kept }, expected) => {
    expect(openingWhitespaceTag(line, next, kept)).toBe(expected);
  },
);

test.each([["&AMP;", "&AMP;"]])(
  "keeps named entities case-sensitive for %s",
  (entity, expected) => {
    expect(decodeEntity(entity)).toBe(expected);
  },
);

test.each([[1 + Number.EPSILON, false]])(
  "rejects a fractional token limit next to the minimum",
  (input, expected) => {
    expect(validTermTokenLimit(input)).toBe(expected);
  },
);
