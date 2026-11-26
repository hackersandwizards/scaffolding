import { expect, test } from "vitest";
import { failParsingInput } from "./json-parse-fault.ts";
import { parseTermList } from "../lib/confidential-input.ts";

test("term-list parsing propagates unexpected parser failures", () => {
  const value = '{"salt":"fixture"}';
  const failure = new RangeError("term-list parser failed");
  using _parse = failParsingInput(value, failure);
  expect(() => parseTermList(value)).toThrow(failure);
});
