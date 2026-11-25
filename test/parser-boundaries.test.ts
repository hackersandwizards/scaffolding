import { fc, unicodeString } from "@hackersandwizards/scaffolding/property";
import { expect, test, vi } from "vitest";
import { lostSpaceTag, spaceTemplateLines } from "../lib/astro-spaces.ts";
import { licenceAllowed } from "../lib/licence-expression.ts";
import { lintRuleOverlaps } from "../lib/lint-rule-overlaps.ts";
import { stagedPaths } from "../lib/staged-paths.ts";
import { commentSyntax, exportTargets, fetchWaitS } from "../lib/repo.ts";

test.each([undefined, "", "0", "000", "1e10", "5.5", " 5", "5 "])(
  "rejects fetch timeout %j",
  (input) => {
    vi.stubEnv("SCAFFOLDING_FETCH_WAIT_S", input);
    try {
      expect(fetchWaitS()).toBe(20);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test("the shared string arbitrary reaches Unicode and strings longer than a typical token", () => {
  const samples = fc.sample(unicodeString, 64);
  expect(samples.some((text) => [...text].some((character) => character.charCodeAt(0) > 127))).toBe(
    true,
  );
  expect(samples.some((text) => text.length >= 256)).toBe(true);
});

test.each([
  ["a.md", "Don't, won't <!-- note -->", "Don't, won't "],
  ["a.html", "Don't, won't <!-- note -->", "Don't, won't "],
  ["a.jsx", "Don't, won't <!-- note -->", "Don't, won't "],
  ["a.htm", "// note", ""],
  ["a.htm", "/* note */", ""],
  ["a.htm", 'text "quoted // value"', 'text "quoted '],
  ["a.jsx", 'text "quoted // value"', 'text "quoted '],
  ["a.asx", 'text "quoted // value"', 'text "quoted // value"'],
  ["a.md.ts", 'const a = "a//b"; const b = "z"; // note', 'const a = "a//b"; const b = "z"; '],
  ["a.ts", "const path = `https://host/path`; /* note */", "const path = `https://host/path`; "],
  ["a.ts", "const path = `//host/path`;", "const path = `//host/path`;"],
  ["a.yml.ts", "const a = 1; // note", "const a = 1; "],
  [".githooks/pre-push", "echo it's # note", "echo it's "],
  ["nested/.githooks/pre-push", "echo hi # note", "echo hi "],
  [".githooks/pre-push.ts", "let a = 2; // note", "let a = 2; "],
  ["bad.githooks/pre-push", "let a = 2; // note", "let a = 2; "],
])("strips only comments in %s", (file, source, expected) => {
  expect(source.replace(commentSyntax(file), "$1")).toBe(expected);
});

test.each([
  ["", false],
  ["MIT OR AND", false],
  ["MIT OR OR", false],
  ["MIT OR WITH", false],
  ["MIT OR AWITH", true],
  ["MIT OR WITHIN", true],
])("classifies incomplete SPDX expressions and unknown identifiers %j", (text, allowed) => {
  expect(licenceAllowed(text)).toBe(allowed);
});

test("staged paths can report a path from a raw record without a file mode", () => {
  expect(stagedPaths(":100644\0file.ts\0")).toEqual({
    staged: ["file.ts"],
    oxlintPaths: [],
    regularPaths: [],
  });
});

test.each([
  '  <script data-x=">x" />',
  "  <style data-x='>x' />",
  "  <pre data-x={a => b} />",
  '  <textarea data-x=">x"> on two lines\n next </textarea>',
  "---\n---",
  "---\r\nwith spaces\n---",
  "  // comment",
])("blanking preserves the columns and line breaks of %j", (hidden) => {
  const lines = hidden.split("\n");
  expect(spaceTemplateLines(`${hidden}\nvisible`)).toEqual([
    ...lines.map((line) => " ".repeat(line.length)),
    "visible",
  ]);
});

test.each([
  "visible\n---\nvisible\n---",
  '<scripted data-x=">" />',
  'const example = "https://host/"',
])("blanking preserves template text %j", (visible) => {
  expect(spaceTemplateLines(visible)).toEqual(visible.split("\n"));
});

test.each([
  ["42{name}", "<a>", false, "a"],
  ["値{name}", "<a>", false, "a"],
  ["!{name}", "<a>", false, false],
  ["<strong>{name}", "<a>", false, false],
  ["} word {name}", "<a>", false, false],
  ["text", "  {<a />}", true, "a"],
  ["text", "{<div />}", true, undefined],
  ["text", "{name}", true, undefined],
  ["text", "prefix {<a />}", true, undefined],
  ["text", "{<a />} tail", true, undefined],
  ["</a>", "<div>", true, undefined],
  ["</a>", "", false, false],
  ["> ", "text", false, "a"],
  ["> extra", "text", false, undefined],
])("detects inline whitespace between %j and %j with kept=%j", (line, next, kept, tag) => {
  expect(lostSpaceTag(line, next, "</a", kept)).toBe(tag);
});

test.each([
  [{}, "react_perf/rule", "react-perf/rule"],
  [{ plugins: {} }, "plugin/rule", "plugin/rule"],
  [{ plugins: { alias: {} } }, "alias/rule", "alias/rule"],
  [{ plugins: { alias: { meta: {} } } }, "alias/rule", "alias/rule"],
  [
    { plugins: { alias: { meta: { name: "eslint-plugin-react_perf" } } } },
    "alias/rule",
    "react-perf/rule",
  ],
  [
    { plugins: { alias: { meta: { name: "eslint-plugin-react_perf" } } } },
    "alias/rule",
    "alias/rule",
  ],
  [
    { plugins: { alias: { meta: { name: "@scope/eslint-plugin-example" } } } },
    "alias/rule",
    "@scope/example/rule",
  ],
  [{ plugins: { alias: { meta: { name: "@scope/eslint-plugin" } } } }, "alias/rule", "@scope/rule"],
])("resolves plugin rules from %j, %s and %s", (config, rule, native) => {
  const [finding] = lintRuleOverlaps("src/file.ts", new Set([native]), {
    ...config,
    rules: { [rule]: "error" },
  });
  expect(finding?.message).toContain(`ESLint rule ${rule} overlaps Oxlint rule ${native}.`);
  expect(
    lintRuleOverlaps("src/file.ts", new Set(["rule"]), { ...config, rules: { [rule]: "error" } }),
  ).toEqual([]);
});

test("export targets do not follow properties on a callable value", () => {
  const callable = Object.assign(() => undefined, { import: "./example.js" });
  expect(exportTargets(callable)).toEqual([]);
});
