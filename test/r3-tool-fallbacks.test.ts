import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { rejection } from "../lib/rejection.ts";
import { loadPrettier, usesSharedVitest } from "../lib/structure-config.ts";
import { testDirectory } from "./test-directory.ts";

const entry = (name: string) => join(import.meta.dirname, "..", "bin", `${name}.ts`);
const runTool = (folder: string, source: string, args: string[]) => {
  const preload = join(folder, ".preload.ts");
  writeFileSync(preload, source);
  return spawnSync(process.execPath, ["--no-env-file", "--preload", preload, ...args], {
    cwd: folder,
    encoding: "utf8",
  });
};

const runFixtureGit = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.email=fixture@example.test", "-c", "user.name=Fixture", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  ).trim();

function writeToolFixture(folder: string, files: Record<string, string>) {
  runFixtureGit(folder, "init", "-q");
  for (const [path, text] of Object.entries(files)) writeFileSync(join(folder, path), text);
  runFixtureGit(folder, "add", "--", ...Object.keys(files));
  runFixtureGit(folder, "commit", "-qm", "fixture");
}

test("unexpected Vitest transpiler failure surfaces", () => {
  const malformed =
    "// @hackersandwizards/scaffolding/vitest\nexport type A = ;\ninterface X { ??? }";
  expect(usesSharedVitest(malformed)).toBe(false);
  using transform = vi.spyOn(Bun.Transpiler.prototype, "transformSync").mockImplementation(() => {
    throw new Error("Vitest transpiler fault");
  });
  const config = 'export { default } from "@hackersandwizards/scaffolding/vitest";';
  expect(() => usesSharedVitest(config)).toThrow("Vitest transpiler fault");
  expect(transform).toHaveBeenCalledWith(config);
});

test("unexpected Prettier loader failure surfaces", async () => {
  using dir = testDirectory();
  const prettier = join(dir.folder, "node_modules", "prettier");
  mkdirSync(prettier, { recursive: true });
  writeFileSync(join(prettier, "index.mjs"), 'throw new Error("Prettier loader fault");');
  expect(await rejection(loadPrettier(dir.folder))).toContain("Prettier loader fault");
});

test("unexpected structure file probe failure surfaces", () => {
  using dir = testDirectory();
  writeToolFixture(dir.folder, { "package.json": "{}" });
  const result = runTool(
    dir.folder,
    `import * as fs from "node:fs";
import { mock } from "bun:test";
const { lstatSync } = fs;
mock.module("node:fs", () => ({ ...fs, lstatSync(file, ...args) {
  if (String(file).endsWith("/.editorconfig")) throw new Error("structure file probe fault");
  return lstatSync(file, ...args);
} }));`,
    [entry("check-structure")],
  );
  expect(result.stderr).toContain("structure file probe fault");
  expect(result.status).toBe(1);
});

test("unexpected relative import resolver failure surfaces", () => {
  using dir = testDirectory();
  writeToolFixture(dir.folder, { "example.js": 'import "./missing";' });
  const result = runTool(
    dir.folder,
    `const { resolveSync } = Bun;
Bun.resolveSync = (specifier, ...args) => {
  if (specifier === "./missing") throw new Error("relative resolver fault");
  return resolveSync(specifier, ...args);
};`,
    [entry("check-cycles")],
  );
  expect(result.stderr).toContain("relative resolver fault");
  expect(result.status).toBe(1);
});

test("unexpected Astro compiler loader failure surfaces", () => {
  using dir = testDirectory();
  writeToolFixture(dir.folder, { "Example.astro": "<p>hello</p>" });
  const compiler = Bun.resolveSync("@astrojs/compiler-rs", join(import.meta.dirname, "..", "lib"));
  const result = runTool(
    dir.folder,
    `import { mock } from "bun:test";
mock.module(${JSON.stringify(compiler)}, () => {
  console.log("Astro compiler initializer reached");
  throw new Error("Astro compiler loader fault");
});`,
    [entry("check-cycles")],
  );
  expect(result.stdout).toContain("Astro compiler initializer reached");
  expect(result.stderr).toContain("error: Astro compiler loader fault");
  expect(result.status).toBe(1);
});

function writeChangedShellFixture(folder: string) {
  writeToolFixture(folder, {
    "package.json": JSON.stringify({
      scaffolding: {
        skip: { test: "Fixture has no test script", admin: "Fixture has no admin items" },
      },
    }),
    "tool.sh": "#!/bin/sh\ntrue\n",
  });
  writeFileSync(join(folder, "tool.sh"), "#!/bin/sh\nfalse\n");
  runFixtureGit(folder, "commit", "-qam", "change shell input");
  writeFileSync(join(folder, "tool.sh"), "#!/bin/sh\ntrue\n");
}

test.each([
  { mode: "working tree", range: [] },
  { mode: "push range", range: ["HEAD^..HEAD"] },
])("unexpected shell input failure surfaces for the $mode", ({ range }) => {
  using dir = testDirectory();
  writeChangedShellFixture(dir.folder);
  const shell = JSON.stringify(join(import.meta.dirname, "..", "lib", "shell-inputs.ts"));
  const result = runTool(
    dir.folder,
    `import * as cp from "node:child_process";
import { mock } from "bun:test";
mock.module("node:child_process", () => ({ ...cp, spawn() {
  throw new Error("fixture should stop before starting checks");
} }));
const shell = await import(${shell});
mock.module(${shell}, () => ({ ...shell, gitShellScripts() {
  throw new Error("shell input fault");
} }));`,
    [entry("scaffolding"), "check", "--changed", ...range, "--locked"],
  );
  expect(result.stderr).toContain("shell input fault");
  expect(result.status).toBe(1);
});

test("a Git launch failure with a filesystem error code surfaces during shell discovery", () => {
  using dir = testDirectory();
  writeChangedShellFixture(dir.folder);
  const result = runTool(
    dir.folder,
    `import * as cp from "node:child_process";
import { mock } from "bun:test";
const { spawnSync } = cp;
mock.module("node:child_process", () => ({
  ...cp,
  spawn() { throw new Error("fixture should stop before starting checks"); },
  spawnSync(command, args, options) {
    if (command === "git" && args[0] === "ls-tree")
      return { status: null, error: Object.assign(new Error("Git launch fault"), { code: "EACCES" }) };
    return spawnSync(command, args, options);
  },
}));`,
    [entry("scaffolding"), "check", "--changed", "--locked"],
  );
  expect(result.stderr).toContain("Git launch fault");
  expect(result.status).toBe(1);
});
