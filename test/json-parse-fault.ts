import { vi } from "vitest";

export function failParsingInput(input: string, failure: Error) {
  const parse = JSON.parse;
  return vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (text === input) throw failure;
    return parse(text, reviver) as unknown;
  });
}
