import { expect, test } from "vitest";
import {
  brandProblem,
  brandRetiredRequirement,
  brandSettingsProblem,
  linksProblem,
  serverProblem,
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

test.each([
  {
    label: "a non-object brand configuration",
    pkg: {
      scaffolding: { brand: [] },
      dependencies: { "@hackersandwizards/brand": "1.0.0" },
    } as unknown as Package,
    expected:
      "scaffolding.brand has an invalid shape or key. In package.json, use an object with only directory, retired and elements as keys.",
  },
  {
    label: "an unknown brand key",
    pkg: {
      scaffolding: { brand: { path: "dist" } },
      dependencies: { "@hackersandwizards/brand": "1.0.0" },
    } as unknown as Package,
    expected:
      "scaffolding.brand has an invalid shape or key. In package.json, use an object with only directory, retired and elements as keys.",
  },
  {
    label: "brand settings without a pin",
    pkg: { scaffolding: { brand: { retired: ["dist"] } } },
    expected:
      "scaffolding.brand configures checks supplied by @hackersandwizards/brand, which this package does not pin. Pin @hackersandwizards/brand in package.json or remove scaffolding.brand.",
  },
])("explains $label", ({ pkg, expected }) => {
  expect(brandProblem(pkg)).toBe(expected);
});

test.each([
  {
    label: "a missing server command",
    server: { stderr: true } as NonNullable<Package["scaffolding"]>["server"],
    expected:
      "scaffolding.server must be an object with a non-blank command to start the server. Fix the object in package.json using command and, optionally, timeout and stderr.",
  },
  {
    label: "a readiness timeout outside the timer range",
    server: { command: "bun start", timeout: 2_147_483.648 },
    expected:
      "scaffolding.server.timeout sets how long the gate waits for the server. In package.json, set it to a number greater than 0 and at most 2147483.647 seconds, or omit it for the default.",
  },
])("explains $label", ({ server, expected }) => {
  expect(serverProblem(server)).toBe(expected);
});

test("explains why links requires a server", () => {
  expect(linksProblem({ check: ["links"] })).toBe(
    "scaffolding.check lists links, which needs a running site to crawl. Set scaffolding.server.command in package.json to the server startup command or remove links from scaffolding.check.",
  );
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
