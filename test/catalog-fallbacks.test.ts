import { expect, test } from "vitest";
import { brandFallbacks, cssFallbackEnd, resolveBrandLiterals } from "../catalog/fallbacks.ts";

test.each([
  { css: "brand-value(--space)", tokens: { __proto__: "ignored", "--space": "" }, expected: "" },
])("resolves an explicitly empty literal", ({ css, tokens, expected }) => {
  expect(resolveBrandLiterals(css, tokens)).toBe(expected);
});

test.each([{ css: "var(--a, f(g(1))) tail)", afterComma: 8, expected: 17 }])(
  "stops at the closing parenthesis of the outer var()",
  ({ css, afterComma, expected }) => {
    expect(cssFallbackEnd(css, afterComma, "--a")).toBe(expected);
  },
);

test.each([
  {
    css: "var(--a, brand-value(--a, 1px)",
    tokens: { "--a": "1px" },
    expected: "catalog: brand-value() takes one custom property name",
  },
])("validates brand literals before examining var() fallbacks", ({ css, tokens, expected }) => {
  expect(() => brandFallbacks(css, tokens)).toThrow(expected);
});
