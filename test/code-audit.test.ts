import { join } from "node:path";
import { expect, test } from "vitest";
import { auditFixture, runCodeAudit, writeAuditFiles } from "./code-audit-fixture.ts";
import { testDirectory } from "./test-directory.ts";

const clone =
  [
    "const opening = choose(1, 2);",
    "const parsing = choose(2, 3);",
    "const reviewing = choose(3, 4);",
    "const publishing = choose(4, 5);",
    "const closing = choose(5, 6);",
  ].join("\n") + "\n";
const fourLines =
  [
    'console.log("open", { channel: "alpha", mode: "strict" });',
    'console.log("parse", { channel: "beta", mode: "strict" });',
    'console.log("review", { channel: "gamma", mode: "strict" });',
    'console.log("publish", { channel: "delta", mode: "strict" });',
  ].join("\n") + "\n";

test.each([
  {
    title: "reports a clone of five lines",
    second: "b.ts",
    source: clone,
    expected: 1,
    output: /a\.ts:1-5 duplicates b\.ts:1-5[\s\S]+\[guide\] duplicated-block/,
  },
  {
    title: "passes a four-line clone",
    second: "b.ts",
    source: fourLines,
    expected: 0,
    output: /no duplicated blocks/,
  },
  {
    title: "passes an exempted clone",
    second: "skeleton/b.ts",
    source: clone,
    expected: 0,
    output: /no duplicated blocks/,
  },
  {
    title: "passes a clone in hub code ignored by ESLint",
    second: ".claude/skills/example/b.ts",
    source: clone,
    expected: 0,
    output: /no duplicated blocks/,
  },
  {
    title: "passes a clone in hook code ignored by ESLint",
    second: ".githooks/b.ts",
    source: clone,
    expected: 0,
    output: /no duplicated blocks/,
  },
  {
    title: "passes a clone in a test",
    second: "b.test.ts",
    source: clone,
    expected: 0,
    output: /no duplicated blocks/,
  },
  {
    title: "passes a clone with fewer than 50 tokens",
    second: "b.ts",
    source: "a();\nb();\nc();\nd();\ne();\n",
    expected: 0,
    output: /no duplicated blocks/,
  },
])("duplicates $title", ({ second, source, expected, output }) => {
  using directory = testDirectory();
  auditFixture(directory.folder, {
    "a.ts": source,
    [second]: source,
    ".oxlintrc.json": JSON.stringify({
      settings: { scaffolding: { duplicates: { "skeleton/**": "Copied by design" } } },
    }),
  });
  const result = runCodeAudit(directory.folder, "duplicates");
  expect(result.status, result.output).toBe(expected);
  expect(result.output).toMatch(output);
});

test("duplicates reports no tracked production sources", () => {
  using directory = testDirectory();
  auditFixture(directory.folder, { "a.test.ts": clone, "a.astro": clone });
  expect(runCodeAudit(directory.folder, "duplicates")).toEqual({
    status: 0,
    output: "[duplicates] no tracked production JavaScript or TypeScript files\n",
  });
});

const auditManifest = JSON.stringify({
  name: "audit-fixture",
  main: "src/index.ts",
  type: "module",
  dependencies: { "sample-production": "1.0.0" },
  devDependencies: { "sample-development": "1.0.0" },
});
const auditKnipConfig = {
  entry: ["src/index.ts!", "test/**/*.test.ts"],
  project: ["src/**/*.ts!", "!test/**!"],
};
const auditConfig = JSON.stringify(auditKnipConfig);
const fixturePackages = Object.fromEntries(
  ["sample-production", "sample-development"].flatMap((name) => [
    [`node_modules/${name}/package.json`, JSON.stringify({ name, main: "index.js" })],
    [`node_modules/${name}/index.js`, "module.exports = {};"],
  ]),
);

const usedDependencies = {
  "src/index.ts": 'import "sample-production";\n',
  "test/entry.test.ts": 'import "sample-development";\n',
};

test.each([
  {
    title: "file",
    bad: { "src/orphan.ts": "export const orphan = 1;\n" },
    good: {
      "src/index.ts":
        usedDependencies["src/index.ts"] +
        'import { orphan } from "./orphan.ts"; console.log(orphan);\n',
    },
    finding: "unused file src/orphan.ts",
    guide: "unused-file",
  },
  {
    title: "export",
    bad: {
      "src/index.ts":
        usedDependencies["src/index.ts"] + 'import { kept } from "./library"; console.log(kept);\n',
      "src/library.ts": "export const kept = 1; export const stray = 2;\n",
    },
    good: { "src/library.ts": "export const kept = 1;\n" },
    finding: "unused export stray",
    guide: "unused-export",
  },
  {
    title: "export referenced only by a test",
    bad: {
      "src/index.ts":
        usedDependencies["src/index.ts"] + 'import { kept } from "./library"; console.log(kept);\n',
      "src/library.ts": "export const kept = 1; export const fixtureOnly = 2;\n",
      "test/entry.test.ts":
        usedDependencies["test/entry.test.ts"] +
        'import { fixtureOnly } from "../src/library"; console.log(fixtureOnly);\n',
    },
    good: {
      "src/index.ts":
        usedDependencies["src/index.ts"] +
        'import { kept, fixtureOnly } from "./library"; console.log(kept, fixtureOnly);\n',
    },
    finding: "unused export fixtureOnly",
    guide: "unused-export",
  },
  {
    title: "dependency",
    bad: { "src/index.ts": "console.log(1);\n" },
    good: { "src/index.ts": usedDependencies["src/index.ts"] },
    finding: "unused dependency sample-production",
    guide: "unused-dependency",
  },
  {
    title: "devDependency",
    bad: { "test/entry.test.ts": "console.log(1);\n" },
    good: { "test/entry.test.ts": usedDependencies["test/entry.test.ts"] },
    finding: "unused dependency sample-development",
    guide: "unused-dependency",
  },
])("unused reports an unused $title and passes its control", ({ bad, good, finding, guide }) => {
  using directory = testDirectory();
  auditFixture(directory.folder, {
    "package.json": auditManifest,
    "knip.json": auditConfig,
    ...usedDependencies,
    ...bad,
  });
  writeAuditFiles(directory.folder, fixturePackages);
  const result = runCodeAudit(directory.folder, "unused");
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain(finding);
  expect(result.output).toContain(`[guide] ${guide}`);
  writeAuditFiles(directory.folder, good);
  expect(runCodeAudit(directory.folder, "unused")).toEqual({ status: 0, output: "" });
});

test("unused fails with Knip's message on a configuration error", () => {
  using directory = testDirectory();
  auditFixture(directory.folder, {
    "package.json": auditManifest,
    "knip.json": "{ broken",
    ...usedDependencies,
  });
  writeAuditFiles(directory.folder, fixturePackages);
  const result = runCodeAudit(directory.folder, "unused");
  expect(result.status).toBe(2);
  expect(result.output).toMatch(/knip\.json/i);
  writeAuditFiles(directory.folder, { "knip.json": auditConfig });
  expect(runCodeAudit(directory.folder, "unused")).toEqual({ status: 0, output: "" });
});

test.each([
  { title: "no manifest", files: { "index.ts": "export {};\n" } },
  {
    title: "no tracked JavaScript or TypeScript",
    files: { "package.json": auditManifest, "index.astro": "---\n---\n" },
  },
])("unused is a no-op with $title", ({ files }) => {
  using directory = testDirectory();
  auditFixture(directory.folder, files);
  expect(runCodeAudit(directory.folder, "unused")).toEqual({
    status: 0,
    output: "[unused] no root package.json or no tracked JavaScript or TypeScript files\n",
  });
});

test("unused keeps an export used in its own file even with Knip's setting off", () => {
  using directory = testDirectory();
  const { folder } = directory;
  auditFixture(folder, {
    "package.json": auditManifest,
    "knip.json": JSON.stringify({ ...auditKnipConfig, ignoreExportsUsedInFile: false }),
    ...usedDependencies,
    "src/index.ts": usedDependencies["src/index.ts"] + 'import "./library.ts";',
    "src/library.ts": "export const live = 1; console.log(live);",
    "test/entry.test.ts":
      usedDependencies["test/entry.test.ts"] +
      'import { live } from "../src/library"; console.log(live);',
  });
  writeAuditFiles(folder, fixturePackages);
  expect(runCodeAudit(folder, "unused")).toEqual({ status: 0, output: "" });
});

test("unused rejects a checkout inside node_modules", () => {
  using directory = testDirectory();
  const { folder } = directory;
  const root = join(folder, "node_modules", "checkout");
  auditFixture(root, { "package.json": "{}", "index.js": "export {};" });
  const result = runCodeAudit(root, "unused");
  expect(result.status).toBe(2);
  expect(result.output).toContain("Knip cannot analyze source paths containing node_modules");
});

test("unused counts gate tools and still reports an unrelated devDependency", () => {
  using directory = testDirectory();
  const { folder } = directory;
  const tools = {
    "@hackersandwizards/scaffolding": "1.0.0",
    typescript: "1.0.0",
    eslint: "1.0.0",
    "@hackersandwizards/admin": "1.0.0",
    "@hackersandwizards/brand": "1.0.0",
    "custom-compiler": "1.0.0",
  };
  const manifest = (devDependencies: Record<string, string>) =>
    JSON.stringify({
      main: "index.js",
      scaffolding: { typecheck: "custom-tsc --noEmit" },
      devDependencies,
    });
  auditFixture(folder, { "package.json": manifest(tools), "index.js": "export {};" });
  writeAuditFiles(folder, {
    "node_modules/@hackersandwizards/admin/package.json": '{"bin":{"admin-check":"bin.js"}}',
    "node_modules/@hackersandwizards/brand/package.json": '{"bin":{"brand-colours":"bin.js"}}',
    "node_modules/custom-compiler/package.json": '{"bin":{"custom-tsc":"bin.js"}}',
  });
  expect(runCodeAudit(folder, "unused")).toEqual({ status: 0, output: "" });
  writeAuditFiles(folder, { "package.json": manifest({ ...tools, unrelated: "1.0.0" }) });
  const red = runCodeAudit(folder, "unused");
  expect(red.status).toBe(1);
  expect(red.output.match(/^\[unused\].*$/gm)).toEqual([
    expect.stringContaining("unused dependency unrelated"),
  ]);
});
