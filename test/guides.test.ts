import { ESLint } from "eslint";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import ownOxlint from "../.oxlintrc.json";
import sharedOxlint from "../config/oxlint.json";
import { guideId, guidesDirectory, renderGuides } from "../lib/guides.ts";
import { isObject } from "../lib/json.ts";
import { activeSeverity, type Rules } from "../lib/lint-rule-overlaps.ts";

const ownChecks = ["layers", "import-cycle", "duplicate-function-name", "generic-folder"];
const upcoming = ["complexity", "max-depth", "max-params", "max-lines-per-function", "max-lines"];

const activeRules = (rules: Rules = {}) =>
  Object.keys(rules).filter((rule) => activeSeverity(rules[rule]));
const oxlintRules = (config: { rules?: Rules; overrides?: { rules?: Rules }[] }) => [
  ...activeRules(config.rules),
  ...(config.overrides ?? []).flatMap(({ rules }) => activeRules(rules)),
];
const eslintRules = async () => {
  const eslint = new ESLint({ cwd: join(import.meta.dirname, "..") });
  const rules = await Promise.all(
    [
      "src/example.ts",
      "test/example.test.ts",
      "test/example.prop.test.ts",
      "src/example.js",
      "src/example.astro",
    ].map(async (file) => {
      const config: unknown = await eslint.calculateConfigForFile(file);
      if (!isObject(config) || !isObject(config.rules))
        throw new Error(`Check the ESLint config for ${file}: no rules apply`);
      return activeRules(config.rules);
    }),
  );
  return rules.flat();
};
const guideFiles = readdirSync(guidesDirectory).filter((file) => file.endsWith(".md"));

test("each rule enforced by the shared configs has a guide", async () => {
  const missing = [...new Set([...oxlintRules(sharedOxlint), ...(await eslintRules())])].filter(
    (rule) => !guideFiles.includes(`${guideId(rule)}.md`),
  );
  expect(missing, "Add a guide under config/guides/ for each rule listed").toEqual([]);
});

test("each guide is reachable from an enforced rule, own check or upcoming rule", async () => {
  const reachable = new Set([
    ...[...oxlintRules(sharedOxlint), ...oxlintRules(ownOxlint), ...(await eslintRules())].map(
      guideId,
    ),
    ...ownChecks,
    ...upcoming,
  ]);
  expect(
    guideFiles.filter((file) => !reachable.has(file.slice(0, -3))),
    "Check the rule configuration and the list of own checks and upcoming rules for each guide listed",
  ).toEqual([]);
});

test("each guide starts with a heading and a blank line", () => {
  for (const file of guideFiles) {
    expect(readFileSync(new URL(file, guidesDirectory), "utf8"), file).toMatch(/^# [^\n]+\n\n/);
  }
});

test("guide ids drop plugin names in ESLint, Oxlint and scaffolding rule names", () => {
  expect(
    [
      "@typescript-eslint/no-explicit-any",
      "typescript/no-explicit-any",
      "typescript-eslint(no-explicit-any)",
      "scaffolding/property",
      "vitest/expect-expect",
    ].map(guideId),
  ).toEqual(["no-explicit-any", "no-explicit-any", "no-explicit-any", "property", "expect-expect"]);
});

test("guides follow first-seen order, with aliases deduplicated and missing guides skipped", () => {
  const output = renderGuides([
    "eslint(no-self-assign)",
    "custom/no-guide-for-this-rule",
    "typescript/no-explicit-any",
    "no-self-assign",
  ]);
  expect(output.match(/^\[guide\] [^:]+/gm)).toEqual([
    "[guide] no-self-assign",
    "[guide] no-explicit-any",
  ]);
  expect(renderGuides(["custom/no-guide-for-this-rule"])).toBe("");
});
