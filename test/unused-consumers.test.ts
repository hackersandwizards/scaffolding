import { expect, test } from "vitest";
import { auditFixture, runCodeAudit, writeAuditFiles } from "./code-audit-fixture.ts";
import { testDirectory } from "./test-directory.ts";

const manifest = (fields = {}) => JSON.stringify({ name: "consumer", main: "index.ts", ...fields });
const entry = "export {};";

test("unused ignores hub, hook and submodule file findings", () => {
  using directory = testDirectory();
  auditFixture(directory.folder, {
    "package.json": manifest(),
    "index.ts": entry,
    ".claude/skills/tool.ts": entry,
    ".githooks/check-lock-record.ts": entry,
    ".gitmodules": '[submodule "source"]\n  path = modules/source\n  url = ./source\n',
    "modules/source/tool.ts": entry,
  });
  expect(runCodeAudit(directory.folder, "unused")).toEqual({ status: 0, output: "" });
});

test("unused excludes tests, stories, declarations and tools but reports a test-only production file", () => {
  using directory = testDirectory();
  const root = directory.folder;
  auditFixture(root, {
    "package.json": manifest({
      devDependencies: { vitest: "1.0.0" },
      scripts: { test: "vitest" },
      "lint-staged": { "*.ts": "node ./lint-setup.ts" },
    }),
    "index.ts": entry,
    "knip.json": JSON.stringify({ project: "**/*.{js,mjs,ts}!", "lint-staged": true }),
    "test/check.ts": entry,
    "test/smoke.test.ts": 'import { test } from "vitest"; test("smoke", () => undefined);',
    "widget.stories.ts": entry,
    "types.d.ts": "export type Example = string;",
    "vitest.config.ts": 'export default { test: { setupFiles: ["./initialize.ts"] } };',
    "vitest.mutation.config.ts": entry,
    "playwright.preview.config.ts": entry,
    "stryker.config.mjs": entry,
    "stylelint.config.js": entry,
    "initialize.ts": entry,
    "lint-setup.ts": entry,
  });
  expect(runCodeAudit(root, "unused")).toEqual({ status: 0, output: "" });
  auditFixture(root, {
    "feature.ts": 'export const feature = "test-only";',
    "test/feature.test.ts": 'import { feature } from "../feature.ts"; console.log(feature);',
  });
  const result = runCodeAudit(root, "unused");
  expect(result.status).toBe(1);
  expect(result.output).toContain("unused file feature.ts");
});

test("unused follows catalog convention entries to their imports", () => {
  using directory = testDirectory();
  const root = directory.folder;
  auditFixture(root, {
    "package.json": manifest({ devDependencies: { astro: "1.0.0" } }),
    "index.ts": entry,
    "astro.config.ts":
      'import { defineConfig } from "astro/config"; import { catalog } from "@hackersandwizards/scaffolding/catalog"; export default defineConfig({ integrations: [catalog({})] });',
    "catalog/stories/Example.stories.ts":
      'import { data } from "../../data.ts"; console.log(data);',
    "catalog/Head.astro": '---\nimport "./head.ts";\n---\n<title>Catalog</title>',
    "catalog/Home.astro": '---\nimport "./home.ts";\n---\n<h1>Catalog</h1>',
    "catalog/head.ts": entry,
    "catalog/home.ts": entry,
    "catalog/pages/about.ts": entry,
    "data.ts": "export const data = 1;",
  });
  writeAuditFiles(root, {
    "catalog/pages/about.astro": '---\nimport "./about.ts";\n---\n<p>About</p>',
  });
  expect(runCodeAudit(root, "unused")).toEqual({ status: 0, output: "" });
  writeAuditFiles(root, {
    "astro.config.ts":
      'import { defineConfig } from "astro/config"; export default defineConfig({});',
  });
  const result = runCodeAudit(root, "unused");
  expect(result.status).toBe(1);
  expect(result.output).toContain("unused file data.ts");
});

test("unused counts tracked CSS, Astro styles and build config imports", () => {
  using directory = testDirectory();
  const root = directory.folder;
  const dependencies = {
    tailwindcss: "1.0.0",
    "@tailwindcss/vite": "1.0.0",
    "@example/theme": "1.0.0",
    "style-plugin": "1.0.0",
    "style-reference": "1.0.0",
  };
  auditFixture(root, {
    "package.json": manifest({ dependencies }),
    "index.ts": 'import "./app.css";',
    "astro.config.mjs": 'import "@tailwindcss/vite"; export default {};',
    "app.css": '@import "tailwindcss";\n@plugin "style-plugin";\n',
    "App.astro":
      '<style is:global>\n@import "@example/theme/tokens.css";\n@reference "style-reference";\n</style>',
  });
  expect(runCodeAudit(root, "unused")).toEqual({ status: 0, output: "" });
  writeAuditFiles(root, {
    "package.json": manifest({ dependencies: { ...dependencies, unrelated: "1.0.0" } }),
  });
  const result = runCodeAudit(root, "unused");
  expect(result.status).toBe(1);
  expect(result.output.match(/^\[unused\].*$/gm)).toEqual([
    expect.stringContaining("unused dependency unrelated"),
  ]);
});

test("unused counts scaffolded tools even without installed binaries", () => {
  using directory = testDirectory();
  auditFixture(directory.folder, {
    "package.json": manifest({
      devDependencies: {
        "@hackersandwizards/scaffolding": "1.0.0",
        "@typescript/native": "npm:typescript@7.0.2",
      },
    }),
    "index.ts": entry,
  });
  expect(runCodeAudit(directory.folder, "unused")).toEqual({ status: 0, output: "" });
});
