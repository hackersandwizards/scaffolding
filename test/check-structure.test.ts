import { expect, test } from "vitest";
import { entry, runTool, writeToolFixture } from "./preloaded-check.ts";
import { testDirectory } from "./test-directory.ts";

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
