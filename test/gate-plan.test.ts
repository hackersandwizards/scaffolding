import { join } from "node:path";
import { expect, test } from "vitest";
import {
  brandElementsCommand,
  buildChangedMappings,
  buildFullOnlyMap,
  buildSharedStepMap,
  GatePlan,
  packageScriptCommand,
  resolveBrandStepCommand,
  resolveLocalReplacement,
  scaffoldingBinCommand,
  shellQuote,
  usesAstroTypecheck,
  validateConfigKeys,
  validateGateIntegrations,
  validatePlacedStepEntries,
  validateRequiredGateFields,
  withServerCommand,
} from "../lib/gate-plan.ts";
import type { Package } from "../lib/repo.ts";

test.each([
  ["plain", "'plain'"],
  ["a b", "'a b'"],
  ["it's", "'it'\\''s'"],
] as const)("shellQuote(%s) returns %s", (input, expected) => {
  expect(shellQuote(input)).toBe(expected);
});

test("scaffoldingBinCommand quotes paths containing spaces", () => {
  expect(scaffoldingBinCommand("/tmp/my repo", "check-links")).toBe(
    "bun '/tmp/my repo/bin/check-links.ts'",
  );
});

type ScaffoldingConfig = NonNullable<Package["scaffolding"]>;

test.each<{
  scripts: Record<string, string> | undefined;
  command: string;
  expected: string;
}>([
  { scripts: { test: "vitest run" }, command: "test", expected: "bun run --silent test" },
  { scripts: { test: "vitest run" }, command: "bun test", expected: "bun test" },
  { scripts: undefined, command: "test", expected: "test" },
])("packageScriptCommand resolves $command", ({ scripts, command, expected }) => {
  expect(packageScriptCommand(scripts, command)).toBe(expected);
});

test.each<{ config: ScaffoldingConfig; expected: string | undefined }>([
  {
    config: { test: "test", allow: [{ check: "coupling", path: "a", reason: "r" }] },
    expected: undefined,
  },
  {
    config: { bogus: true } as unknown as ScaffoldingConfig,
    expected: "unknown key scaffolding.bogus",
  },
  {
    config: { allow: [{ check: "unknown", path: "a", reason: "r" }] },
    expected: "scaffolding.allow names no check that reads it: unknown",
  },
])("validateConfigKeys checks %j", ({ config, expected }) => {
  expect(validateConfigKeys(config)).toBe(expected);
});

test.each([
  {
    label: "passes when test and admin are present",
    pkg: {
      devDependencies: { "@hackersandwizards/admin": "1.0.0" },
      scaffolding: { test: "test" },
    } as Package,
    expected: undefined,
  },
  {
    label: "rejects missing test without skip",
    pkg: { devDependencies: { "@hackersandwizards/admin": "1.0.0" }, scaffolding: {} } as Package,
    expected: "scaffolding.test is missing: name the tests, or skip.test with a reason",
  },
  {
    label: "rejects missing admin without skip",
    pkg: { scaffolding: { test: "test" } } as Package,
    expected: "@hackersandwizards/admin is not pinned: pin it, or skip.admin with a reason",
  },
])("validateRequiredGateFields: $label", ({ pkg, expected }) => {
  expect(validateRequiredGateFields(pkg)).toBe(expected);
});

test("validateGateIntegrations surfaces browserTest problems", () => {
  const bad: Package = { scaffolding: { test: "test", browserTest: "test/browser" } };
  expect(validateGateIntegrations(bad)).toContain("browserTest");
  expect(validateGateIntegrations({ scaffolding: { test: "test" } })).toBeUndefined();
});

test("buildSharedStepMap builds browserTest exclude command when configured", () => {
  const root = join(import.meta.dirname, "..");
  const steps = buildSharedStepMap({ scaffolding: { browserTest: "test/browser" } }, root, root);
  expect(steps.test).toContain("--exclude 'test/browser/**'");
  expect(steps.confidential).toContain("check-confidential.ts' --index");
});

test.each([
  {
    server: { command: "bun run preview", timeout: 30, stderr: true },
    expected:
      "bun '/home/bin/with-server.ts' --timeout 30 --stderr 'bun run preview' -- check-links {url}",
  },
  {
    server: { command: "bun run preview" },
    expected: "bun '/home/bin/with-server.ts' 'bun run preview' -- check-links {url}",
  },
])("withServerCommand formats flags for %j", ({ server, expected }) => {
  expect(withServerCommand("/home", server, "check-links {url}")).toBe(expected);
});

test.each<{
  step: string;
  local: string[];
  scripts: Record<string, string>;
  expected: { replacement?: string; problem?: string };
}>([
  { step: "links", local: ["check:other"], scripts: {}, expected: {} },
  {
    step: "links",
    local: ["check:links"],
    scripts: { "check:links": "bun run custom" },
    expected: { replacement: "check:links" },
  },
  {
    step: "links",
    local: ["check:links"],
    scripts: {},
    expected: { problem: "scaffolding.check requires a script named check:links" },
  },
])("resolveLocalReplacement resolves $step", ({ step, local, scripts, expected }) => {
  expect(resolveLocalReplacement(step, local, scripts)).toEqual(expected);
});

test.each<{
  label: string;
  config: ScaffoldingConfig;
  directory: string;
  expected: { kind: "full"; command: string } | { problem: string };
}>([
  {
    label: "uses plain brand-elements when not server mode",
    config: {},
    directory: "cd 'app' && ",
    expected: { kind: "full", command: "cd 'app' && brand-elements" },
  },
  {
    label: "requires server when elements is server",
    config: { brand: { elements: "server" } },
    directory: "",
    expected: { problem: "scaffolding.server is required for a server-backed check" },
  },
  {
    label: "wraps brand-elements with server and directory",
    config: { brand: { elements: "server" }, server: { command: "bun start" } },
    directory: "cd 'app' && ",
    expected: {
      kind: "full",
      command:
        "bun '/home/bin/with-server.ts' 'bun start' -- sh -c 'cd '\\''app'\\'' && exec brand-elements --base \"$1\"' sh {url}",
    },
  },
])("brandElementsCommand: $label", ({ config, directory, expected }) => {
  expect(brandElementsCommand(config, directory, "/home")).toEqual(expected);
});

test.each([
  { step: "colours" as const, expected: { kind: "shared", command: "cd 'web' && brand-colours" } },
  { step: "copies" as const, expected: { kind: "shared", command: "brand-copies" } },
  { step: "retired" as const, expected: { kind: "full", command: "brand-retired 'old' 'two'" } },
])("resolveBrandStepCommand handles $step", ({ step, expected }) => {
  const config = { brand: { directory: "web", retired: ["old", "two"] } };
  expect(resolveBrandStepCommand(step, config, "/home")).toEqual(expected);
});

test("GatePlan.addBrandSteps records replacements and fills shared and full brand steps", () => {
  const plan = new GatePlan({});
  const err = plan.addBrandSteps(
    {
      dependencies: { "@hackersandwizards/brand": "1.0.0" },
      scripts: { "check:colours": "bun run my-colours" },
      scaffolding: { check: ["check:colours"] },
    },
    "/home",
  );
  expect(err).toBeUndefined();
  expect(plan.replacements.get("colours")).toBe("check:colours");
  expect(plan.shared.copies).toBe("brand-copies");
  expect(plan.full.has("elements")).toBe(true);
});

test.each<{
  label: string;
  brand: ScaffoldingConfig["brand"];
  shared: Record<string, string>;
  expected: string | undefined;
}>([
  {
    label: "flags unused brand.retired",
    brand: { retired: ["a"] },
    shared: {},
    expected: "brand.retired",
  },
  {
    label: "flags unused brand.directory",
    brand: { directory: "web" },
    shared: {},
    expected: "brand.directory",
  },
  {
    label: "allows brand.directory when colours runs",
    brand: { directory: "web" },
    shared: { colours: "brand-colours" },
    expected: undefined,
  },
])("GatePlan.unusedBrandKey: $label", ({ brand, shared, expected }) => {
  const plan = new GatePlan(shared);
  expect(plan.unusedBrandKey(brand)).toBe(expected);
});

test.each<{
  label: string;
  config: ScaffoldingConfig;
  replacements: [string, string][];
  expected: string | undefined;
}>([
  {
    label: "flags unused linkSkips",
    config: { linkSkips: ["/draft"] },
    replacements: [],
    expected: "linkSkips",
  },
  {
    label: "allows server when links uses local replacement",
    config: { server: { command: "bun start" } },
    replacements: [["links", "check:links"]],
    expected: undefined,
  },
  {
    label: "flags unused server",
    config: { server: { command: "bun start" } },
    replacements: [],
    expected: "server",
  },
])("GatePlan.unusedConfigKey: $label", ({ config, replacements, expected }) => {
  const plan = new GatePlan({});
  for (const [step, replacement] of replacements) plan.replacements.set(step, replacement);
  expect(plan.unusedConfigKey(config)).toBe(expected);
});

test.each([
  {
    label: "flags duplicate placed step",
    entries: ["links", "links"],
    replacements: new Map<string, string>(),
    named: new Set(["links"]),
    expected: "scaffolding.check lists links more than once",
  },
  {
    label: "flags disabled placed step",
    entries: ["links"],
    replacements: new Map<string, string>(),
    named: new Set<string>(),
    expected: "scaffolding.check names no enabled shared step: links",
  },
  {
    label: "accepts enabled placed step once",
    entries: ["links"],
    replacements: new Map<string, string>(),
    named: new Set(["links"]),
    expected: undefined,
  },
])("validatePlacedStepEntries: $label", ({ entries, replacements, named, expected }) => {
  expect(validatePlacedStepEntries(entries, replacements, named)).toBe(expected);
});

test.each<{
  label: string;
  config: ScaffoldingConfig;
  local: string[];
  expectedProblem: string;
}>([
  {
    label: "rejects non-object fullOnly",
    config: { fullOnly: "bad" } as unknown as ScaffoldingConfig,
    local: [],
    expectedProblem: "scaffolding.fullOnly must be a map of steps to reasons",
  },
  {
    label: "rejects ineligible step",
    config: { fullOnly: { lint: "slow" } },
    local: [],
    expectedProblem: "scaffolding.fullOnly names no eligible step: lint",
  },
  {
    label: "rejects missing reason",
    config: { fullOnly: { test: "   " } },
    local: [],
    expectedProblem: "scaffolding.fullOnly.test has no reason",
  },
])("buildFullOnlyMap rejects: $label", ({ config, local, expectedProblem }) => {
  expect(buildFullOnlyMap(config, local).problem).toBe(expectedProblem);
});

test("buildFullOnlyMap adds eligible local step with reason", () => {
  const result = buildFullOnlyMap({ fullOnly: { "check:e2e": "needs browser" } }, ["check:e2e"]);
  expect(result.problem).toBeUndefined();
  expect(result.fullOnly?.get("check:e2e")).toBe("needs browser");
});

test.each<{
  label: string;
  config: ScaffoldingConfig;
  named: Set<string>;
  expectedProblem: string;
}>([
  {
    label: "rejects non-object changed",
    config: { changed: [] } as unknown as ScaffoldingConfig,
    named: new Set(["test"]),
    expectedProblem: "scaffolding.changed must be a map of paths to steps",
  },
  {
    label: "rejects invalid glob",
    config: { changed: { "../outside": ["test"] } },
    named: new Set(["test"]),
    expectedProblem: 'scaffolding.changed["../outside"] is no repository-relative glob',
  },
  {
    label: "rejects empty step list",
    config: { changed: { "src/**": [] } },
    named: new Set(["test"]),
    expectedProblem: 'scaffolding.changed["src/**"] is an empty list of steps',
  },
  {
    label: "rejects unknown step name",
    config: { changed: { "src/**": ["missing"] } },
    named: new Set(["test"]),
    expectedProblem: 'scaffolding.changed["src/**"] names no step: missing',
  },
])("buildChangedMappings rejects: $label", ({ config, named, expectedProblem }) => {
  expect(buildChangedMappings(config, named).problem).toBe(expectedProblem);
});

test.each<{
  typecheck: string;
  scripts: Record<string, string> | undefined;
  expected: boolean;
}>([
  { typecheck: "astro check", scripts: undefined, expected: true },
  { typecheck: "typecheck:site", scripts: { "typecheck:site": "astro check" }, expected: true },
  { typecheck: "tsc --noEmit", scripts: { test: "vitest" }, expected: false },
])("usesAstroTypecheck($typecheck) is $expected", ({ typecheck, scripts, expected }) => {
  expect(usesAstroTypecheck(typecheck, scripts)).toBe(expected);
});
