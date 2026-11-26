import { expect, expectTypeOf, test } from "vitest";
import { defined } from "../lib/defined.ts";

test.each([
  ["text", "text"],
  [0, 0],
  ["", ""],
  [false, false],
  [Number.NaN, Number.NaN],
])("returns defined values unchanged (%j)", (input, expected) => {
  expect(defined(input, "value")).toBe(expected);
});

test.each([
  [undefined, "undefined"],
  [null, "null"],
])("throws naming what when the value is %s", (input, label) => {
  expect(() => defined(input, "the target path")).toThrow(
    `expected the target path to be defined, got ${label}`,
  );
});

test("narrows nullable values to their non-null type", () => {
  const value: string | null | undefined = "ready";
  const narrowed = defined(value, "status");
  expectTypeOf(narrowed).toEqualTypeOf<string>();
  expect(narrowed).toBe("ready");
});

test("resolves through the @hackersandwizards/scaffolding/defined export", async () => {
  const exported = await import("@hackersandwizards/scaffolding/defined");
  expect(exported.defined).toBe(defined);
});
