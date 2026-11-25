import { expect, test } from "vitest";
import { parseTermList } from "../lib/confidential-input.ts";

test.each([["{", undefined]])("rejects the fixed malformed term list %j", (input, result) => {
  expect(parseTermList(input)).toBe(result);
});
