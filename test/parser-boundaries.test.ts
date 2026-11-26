import { fc, unicodeString } from "@hackersandwizards/scaffolding/property";
import { assert, expect, test, vi } from "vitest";
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

test.each(
  [
    { source: "</a\n42{name}\n<a>", kept: false, tag: "a" },
    { source: "</a\n値{name}\n<a>", kept: false, tag: "a" },
    { source: "</a\n!{name}\n<a>", kept: false, tag: false },
    { source: "</a\n<strong>{name}\n<a>", kept: false, tag: false },
    { source: "</a\n} word {name}\n<a>", kept: false, tag: false },
    { source: "</a\ntext\n  {<a />}", kept: true, tag: "a" },
    { source: "</a\ntext\n{<div />}", kept: true, tag: undefined },
    { source: "</a\ntext\n{name}", kept: true, tag: undefined },
    { source: "</a\ntext\nprefix {<a />}", kept: true, tag: undefined },
    { source: "</a\ntext\n{<a />} tail", kept: true, tag: undefined },
    { source: "</a\n</a>\n<div>", kept: true, tag: undefined },
    { source: "</a\n</a>\n", kept: false, tag: false },
    { source: "</a\n> \ntext", kept: false, tag: "a" },
    { source: "</a\n> extra\ntext", kept: false, tag: undefined },
  ].map((row) => ({
    ...row,
    name: `${JSON.stringify(row.source)} with kept=${row.kept}`,
  })),
)("detects inline whitespace between $name", ({ source, kept, tag }) => {
  expect(lostSpaceTag(spaceTemplateLines(source), 1, kept)).toBe(tag);
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
  assert(finding, "the ESLint and Oxlint overlap");
  expect(finding.message).toContain(`ESLint rule ${rule} overlaps Oxlint rule ${native}.`);
  expect(
    lintRuleOverlaps("src/file.ts", new Set(["rule"]), { ...config, rules: { [rule]: "error" } }),
  ).toEqual([]);
});

test("export targets do not follow properties on a callable value", () => {
  const callable = Object.assign(() => undefined, { import: "./example.js" });
  expect(exportTargets(callable)).toEqual([]);
});

function failLicenceLookup(failure: Error) {
  const has = Set.prototype.has;
  return vi.spyOn(Set.prototype, "has").mockImplementation(function (this: Set<unknown>, key) {
    if (key === "MIT") throw failure;
    return has.call(this, key);
  });
}

test("licence expressions propagate unexpected allow-set failures", () => {
  const failure = new RangeError("licence lookup failed");
  using _find = failLicenceLookup(failure);
  expect(() => licenceAllowed("MIT")).toThrow(failure);
});

test("licence expressions reject deeply nested unclosed groups", () => {
  const expression = "(".repeat(100_000) + "MIT";
  expect(licenceAllowed(expression)).toBe(false);
});
