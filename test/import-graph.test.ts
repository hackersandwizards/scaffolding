import { join } from "node:path";
import { expect, test } from "vitest";
import { entry, runTool, writeToolFixture } from "./preloaded-check.ts";
import { testDirectory } from "./test-directory.ts";

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
