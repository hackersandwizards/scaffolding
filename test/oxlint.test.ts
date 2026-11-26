import { expect, test } from "vitest";
import {
  importRestrictionGuidance,
  syntaxRestrictionGuidance,
  validateOxlintRuntimeOptions,
} from "../lib/oxlint.ts";

test.each([
  [
    { options: { typeAware: false }, ignorePatterns: 4, plugins: null },
    "options.typeAware must be true",
  ],
])("reports invalid runtime options before ignored paths and plugin errors", (input, expected) => {
  expect(() => validateOxlintRuntimeOptions(input)).toThrow(expected);
});

test.each([[{ regex: "^blocked/", group: ["alternative"], message: " " }, '"^blocked/"']])(
  "reports import regexes before groups and rejects whitespace-only reasons",
  (input, expected) => {
    expect(
      [...importRestrictionGuidance("rules.no-restricted-imports", [{ patterns: [input] }])].map(
        ({ text }) => text,
      ),
    ).toEqual([expected]);
  },
);

test.each([[[{ selector: 9 }, { selector: "NewExpression", message: " " }], '"NewExpression"']])(
  "reports syntax selectors with blank reasons and ignores non-string selectors",
  (input, expected) => {
    expect(
      [...syntaxRestrictionGuidance("rules.no-restricted-syntax", input)].map(({ text }) => text),
    ).toEqual([expected]);
  },
);
