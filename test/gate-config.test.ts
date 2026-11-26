import { expect, test } from "vitest";
import {
  brandRetiredRequirement,
  brandSettingsProblem,
  serverTimeoutFits,
} from "../lib/gate-config.ts";
import type { Package } from "../lib/repo.ts";

test.each([
  [
    { directory: "..", retired: [], elements: false },
    "scaffolding.brand.directory must be a repository-relative path",
  ],
])("checks the brand directory before retired and elements", (input, expected) => {
  expect(brandSettingsProblem(input)).toBe(expected);
});

test.each([[{ check: 42 } as unknown as Package["scaffolding"], ".flat is not a function"]])(
  "throws when a pinned brand has a non-array check list",
  (input, expected) => {
    expect(() => brandRetiredRequirement(input, undefined)).toThrow(expected);
  },
);

test.each([[2_147_483.647001, false]])(
  "rejects server timeouts that round beyond the timer limit",
  (input, expected) => {
    expect(serverTimeoutFits(input)).toBe(expected);
  },
);
