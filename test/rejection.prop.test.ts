import { fc, test } from "@hackersandwizards/scaffolding/property";
import { expect, expectTypeOf } from "vitest";
import { rejection } from "../lib/rejection.ts";

test.prop([
  fc
    .jsonValue()
    .filter((value) => typeof value !== "string" && JSON.stringify(value).length <= 200),
])("resolved non-string JSON within the display limit keeps its serialization", async (value) => {
  const json = JSON.stringify(value);
  expect(await rejection(rejection(Promise.resolve(value)))).toBe(
    `Error: expected a rejection, resolved with ${json}`,
  );
});

test.prop([fc.integer({ min: 196, max: 204 }), fc.stringMatching(/^[a-z]$/)], {
  examples: [
    [5000, "x"],
    [198, "x"],
    [199, "x"],
  ],
})("clipping starts after 200 serialized characters", async (length, char) => {
  expectTypeOf(char).toEqualTypeOf<string>();
  const shown =
    length <= 198 ? `"${char.repeat(length)}"` : `"${char.repeat(199)}… (${length + 2} characters)`;
  expect(await rejection(rejection(Promise.resolve(char.repeat(length))))).toBe(
    `Error: expected a rejection, resolved with ${shown}`,
  );
});
