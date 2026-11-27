import { expect, test } from "vitest";
import { auditFixture, runCodeAudit, writeAuditFiles } from "./code-audit-fixture.ts";
import { testDirectory } from "./test-directory.ts";

const manifest = (fields = {}) => JSON.stringify({ name: "consumer", main: "index.ts", ...fields });
const entry = "export {};";
const skillExportReference = "Read **skill-assets/schema** or run `scripts/render.sh`.";

test.each(["vitest.config.ts", "vite.config.ts"])(
  "unused follows %s and tests when scaffolding supplies Vitest",
  (config) => {
    using directory = testDirectory();
    const root = directory.folder;
    auditFixture(root, {
      "package.json": manifest({
        scripts: { test: "scaffolding test" },
        devDependencies: {
          "@hackersandwizards/scaffolding": "1.0.0",
          "@testing-library/jest-dom": "1.0.0",
          "@testing-library/react": "1.0.0",
          "@vitejs/plugin-react": "1.0.0",
          jsdom: "1.0.0",
        },
      }),
      "index.ts": entry,
      [config]: `import react from "@vitejs/plugin-react";
      export default { plugins: [react()], test: { environment: "jsdom", setupFiles: ["./test/setup.ts"] } };`,
      "test/example.test.tsx": 'import { render } from "@testing-library/react"; render(<div />);',
      "test/setup.ts": 'import "@testing-library/jest-dom";',
    });
    writeAuditFiles(root, {
      "node_modules/@vitejs/plugin-react/package.json": '{"type":"module","exports":"./index.js"}',
      "node_modules/@vitejs/plugin-react/index.js": "export default () => ({ name: 'react' });",
    });
    expect(runCodeAudit(root, "unused")).toEqual({ status: 0, output: "" });
  },
);

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

test("unused counts exact node_modules paths in tracked Python", () => {
  using directory = testDirectory();
  const root = directory.folder;
  auditFixture(root, {
    "package.json": manifest({
      dependencies: { "python-assets": "1.0.0" },
      devDependencies: {
        "@example/templates": "1.0.0",
        "docs-only": "1.0.0",
        "excluded-paths": "1.0.0",
        "prefix-only": "1.0.0",
        "unreferenced-package": "1.0.0",
      },
    }),
    "index.ts": entry,
    "scripts/render.py": [
      'template = "node_modules/@example/templates/layout.json"',
      'assets = "node_modules/python-assets"',
      'other = "node_modules/prefix-onlyx/layout.json"',
    ].join("\n"),
    "assets/binary.dat": `${"x".repeat(9000)}\0node_modules/excluded-paths`,
    "bun.lock": '["node_modules/excluded-paths"]',
    "coverage/render.py": 'path = "node_modules/excluded-paths"',
    "docs/reference.md": "Read `node_modules/docs-only/reference.json`.",
    "node_modules/other/render.py": 'path = "node_modules/excluded-paths"',
  });
  writeAuditFiles(root, { "untracked.py": 'path = "node_modules/excluded-paths"' });
  const result = runCodeAudit(root, "unused");
  expect(result.status).toBe(1);
  expect(result.output.match(/unused dependency \S+/g)?.sort()).toEqual([
    "unused dependency docs-only",
    "unused dependency excluded-paths",
    "unused dependency prefix-only",
    "unused dependency unreferenced-package",
  ]);
});

test("unused keeps package path references in their own workspace", () => {
  using directory = testDirectory();
  const root = directory.folder;
  const dependencies = { "workspace-assets": "1.0.0" };
  const devDependencies = { "workspace-templates": "1.0.0" };
  auditFixture(root, {
    "package.json": manifest({ workspaces: ["packages/*"], dependencies, devDependencies }),
    "index.ts": entry,
    "packages/child/package.json": manifest({ name: "child", dependencies, devDependencies }),
    "packages/child/index.ts": entry,
    "packages/child/render.py":
      'assets = "node_modules/workspace-assets"\ntemplates = "node_modules/workspace-templates"',
  });
  for (const ignoreWorkspaces of [["packages/child!"], ["packages/child"], []]) {
    writeAuditFiles(root, { "knip.json": JSON.stringify({ ignoreWorkspaces }) });
    const result = runCodeAudit(root, "unused");
    expect(result.status).toBe(1);
    expect(result.output.match(/^\[unused\].*$/gm)?.sort()).toEqual([
      "[unused] package.json:1: unused dependency workspace-assets",
      "[unused] package.json:1: unused dependency workspace-templates",
    ]);
  }
});

test.each([
  {
    scenario: "skill export",
    file: ".claude/skills/example/SKILL.md",
    reference: skillExportReference,
    name: "skill-assets",
    status: 0,
    findings: null,
  },
  {
    scenario: "skill file path with a placeholder",
    file: ".claude/skills/example/paths.txt",
    reference: "Read `@example/skill-assets/profiles/<folder>/bio.md`.",
    name: "@example/skill-assets",
    status: 0,
    findings: null,
  },
  {
    scenario: "docs mention",
    file: "docs/reference.md",
    reference: skillExportReference,
    name: "skill-assets",
    status: 1,
    findings: ["unused dependency skill-assets"],
  },
  {
    scenario: "package name prefix",
    file: ".claude/skills/example/SKILL.md",
    reference: "Read `skill-assets-extra/profiles` and `xskill-assets/profiles`.",
    name: "skill-assets",
    status: 1,
    findings: ["unused dependency skill-assets"],
  },
  {
    scenario: "missing package subpath",
    file: ".claude/skills/example/SKILL.md",
    reference: [
      "`skill-assets/profiles/missing.md`",
      "`skill-assets/profiles/sample/bio.md/missing`",
      "`skill-assets/missing/<folder>/bio.md`",
      "`skill-assets/profiles/sample/bio.md/<folder>`",
    ].join("\n"),
    name: "skill-assets",
    status: 1,
    findings: ["unused dependency skill-assets"],
  },
])("unused checks a $scenario", ({ file, reference, name, status, findings }) => {
  using directory = testDirectory();
  const root = directory.folder;
  auditFixture(root, {
    "package.json": manifest({ dependencies: { [name]: "1.0.0" } }),
    "index.ts": entry,
    [file]: reference,
  });
  writeAuditFiles(root, {
    [`node_modules/${name}/package.json`]: JSON.stringify({
      name,
      exports: { "./schema": "./dist/schema.js" },
    }),
    [`node_modules/${name}/dist/schema.js`]: entry,
    [`node_modules/${name}/profiles/sample/bio.md`]: "# Profile",
    "node_modules/skill-assets-extra/profiles/sample/bio.md": "# Profile",
    "node_modules/xskill-assets/profiles/sample/bio.md": "# Profile",
  });
  const result = runCodeAudit(root, "unused");
  expect(result.status).toBe(status);
  expect(result.output.match(/unused dependency \S+/g)).toEqual(findings);
});

test.each([
  {
    scenario: "CLI path and Bun spawn together",
    source: [
      'export const LOCAL_SERVER = join(ROOT, "node_modules/.bin/mcp-fixture-server");',
      'runCommand(process.execPath, ["run", "--cwd", ROOT, "mcp-fixture-server"]);',
    ].join("\n"),
    bin: { "mcp-fixture-server": "cli.js" },
    status: 0,
    findings: null,
  },
  {
    scenario: "CLI path alone",
    source: 'export const LOCAL_SERVER = "node_modules/.bin/mcp-fixture-server";',
    bin: "cli.js",
    status: 0,
    findings: null,
  },
  {
    scenario: "Bun spawn alone",
    source: 'runCommand(process.execPath, ["run", "--cwd", ROOT, "mcp-fixture-server"]);',
    bin: { "mcp-fixture-server": "cli.js" },
    status: 0,
    findings: null,
  },
  {
    scenario: "Bun command string",
    source: 'exec("bun run mcp-fixture-server");',
    bin: { "mcp-fixture-server": "cli.js" },
    status: 0,
    findings: null,
  },
  {
    scenario: "unknown binary",
    source: 'runCommand("bun", ["run", "mcp-fixture-server-extra"]);',
    bin: { "mcp-fixture-server": "cli.js" },
    status: 1,
    findings: ["unused dependency @example/mcp-fixture-server"],
  },
  {
    scenario: "binary of an undeclared package",
    source: 'export const LOCAL_SERVER = "node_modules/.bin/mcp-fixture-server";',
    bin: { "other-command": "cli.js" },
    unlistedBin: { "mcp-fixture-server": "cli.js" },
    status: 1,
    findings: ["unused dependency @example/mcp-fixture-server"],
  },
])("unused checks a $scenario", ({ source, bin, unlistedBin, status, findings }) => {
  using directory = testDirectory();
  const root = directory.folder;
  const name = "@example/mcp-fixture-server";
  auditFixture(root, {
    "package.json": manifest({
      main: "scripts/mcp/gated.ts",
      dependencies: { [name]: "1.0.0" },
    }),
    "scripts/mcp/gated.ts": source,
  });
  writeAuditFiles(root, {
    [`node_modules/${name}/package.json`]: JSON.stringify({ name, bin }),
    [`node_modules/${name}/cli.js`]: entry,
    "node_modules/@example/unlisted/package.json": JSON.stringify({
      name: "@example/unlisted",
      bin: unlistedBin,
    }),
    "node_modules/@example/unlisted/cli.js": entry,
  });
  const result = runCodeAudit(root, "unused");
  expect(result.status).toBe(status);
  expect(result.output.match(/unused dependency \S+/g)).toEqual(findings);
});

test("unused credits a hoisted binary only in the referencing workspace", () => {
  using directory = testDirectory();
  const root = directory.folder;
  const name = "@example/fixture-tool";
  const dependencies = { [name]: "1.0.0" };
  auditFixture(root, {
    "package.json": manifest({ workspaces: ["packages/*"], dependencies }),
    "index.ts": entry,
    "packages/child/package.json": manifest({ name: "child", devDependencies: dependencies }),
    "packages/child/index.ts": 'runCommand("bun", ["run", "fixture-tool"]);',
  });
  writeAuditFiles(root, {
    [`node_modules/${name}/package.json`]: JSON.stringify({ name, bin: "cli.js" }),
    [`node_modules/${name}/cli.js`]: entry,
  });
  const result = runCodeAudit(root, "unused");
  expect(result.status).toBe(1);
  expect(result.output.match(/^\[unused\].*$/gm)).toEqual([
    "[unused] package.json:1: unused dependency @example/fixture-tool",
  ]);
});

test("unused counts imports used only by hub skills and hooks in both modes", () => {
  using directory = testDirectory();
  const root = directory.folder;
  auditFixture(root, {
    "package.json": manifest({
      dependencies: { "skill-renderer": "1.0.0" },
      devDependencies: { "hook-support": "1.0.0" },
    }),
    "index.ts": entry,
    ".claude/skills/example/run.ts": 'import "./lib/render.ts";',
    ".claude/skills/example/lib/render.ts": 'import "skill-renderer";',
    ".githooks/check.ts": 'import "hook-support";',
  });
  expect(runCodeAudit(root, "unused")).toEqual({ status: 0, output: "" });
  writeAuditFiles(root, {
    ".claude/skills/example/lib/render.ts": entry,
    ".githooks/check.ts": entry,
  });
  const result = runCodeAudit(root, "unused");
  expect(result.status).toBe(1);
  expect(result.output).toContain("unused dependency skill-renderer");
  expect(result.output).toContain("unused dependency hook-support");
});

test("unused counts imports from Astro build configs with Knip's Astro plugin enabled", () => {
  using directory = testDirectory();
  const root = directory.folder;
  auditFixture(root, {
    "package.json": manifest({
      dependencies: {
        "@tailwindcss/vite": "1.0.0",
        "catalog-addon": "1.0.0",
        "astro-addon": "1.0.0",
      },
      devDependencies: { astro: "1.0.0" },
    }),
    "index.ts": entry,
    "astro.config.ts":
      'import { defineConfig } from "astro/config"; import "@tailwindcss/vite"; import "./astro-options.ts"; export default defineConfig({});',
    "astro-options.ts": 'import "astro-addon";',
    "catalog/astro.config.ts": 'import "./configure.ts"; export default {};',
    "catalog/configure.ts": 'import "catalog-addon";',
  });
  expect(runCodeAudit(root, "unused")).toEqual({ status: 0, output: "" });
  writeAuditFiles(root, {
    "astro.config.ts":
      'import { defineConfig } from "astro/config"; import "./astro-options.ts"; export default defineConfig({});',
    "astro-options.ts": entry,
    "catalog/configure.ts": entry,
  });
  const result = runCodeAudit(root, "unused");
  expect(result.status).toBe(1);
  expect(result.output).toContain("unused dependency @tailwindcss/vite");
  expect(result.output).toContain("unused dependency catalog-addon");
  expect(result.output).toContain("unused dependency astro-addon");
});

test("unused credits gate peers and binaries declared as production dependencies", () => {
  using directory = testDirectory();
  const root = directory.folder;
  const consumer = {
    devDependencies: { "@hackersandwizards/scaffolding": "1.0.0" },
    scaffolding: { typecheck: "fixture-tsc --noEmit" },
  };
  const dependencies = { astrobook: "1.0.0", "fixture-compiler": "1.0.0" };
  auditFixture(root, {
    "package.json": manifest({ ...consumer, dependencies }),
    "index.ts": entry,
  });
  writeAuditFiles(root, {
    "node_modules/fixture-compiler/package.json": '{"bin":{"fixture-tsc":"bin.js"}}',
  });

  expect(runCodeAudit(root, "unused")).toEqual({ status: 0, output: "" });
  writeAuditFiles(root, {
    "package.json": manifest({
      ...consumer,
      dependencies: { ...dependencies, unrelated: "1.0.0" },
    }),
  });
  const result = runCodeAudit(root, "unused");
  expect(result.status).toBe(1);
  expect(result.output.match(/^\[unused\].*$/gm)).toEqual([
    expect.stringContaining("unused dependency unrelated"),
  ]);
});

test("unused credits the package dynamically loaded by astro check", () => {
  using directory = testDirectory();
  const root = directory.folder;
  const project = {
    dependencies: { "@astrojs/check": "1.0.0" },
    devDependencies: { "@hackersandwizards/scaffolding": "1.0.0", astro: "1.0.0" },
  };
  const packageWithTypecheck = (typecheck: string) =>
    manifest({
      ...project,
      scaffolding: { typecheck },
    });
  auditFixture(root, {
    "package.json": packageWithTypecheck("astro check"),
    "index.ts": entry,
  });
  expect(runCodeAudit(root, "unused")).toEqual({ status: 0, output: "" });
  writeAuditFiles(root, { "package.json": packageWithTypecheck("astro sync") });
  const result = runCodeAudit(root, "unused");
  expect(result.status).toBe(1);
  expect(result.output).toContain("unused dependency @astrojs/check");
});
