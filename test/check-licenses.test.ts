import { expect, test } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { inputTestRepo, runInputCheck } from "./preloaded-check.ts";
import { testDirectory } from "./test-directory.ts";

test("check-licenses lets an unexpected lockfile read error surface", () => {
  using fixture = testDirectory();
  inputTestRepo(fixture.folder);
  mkdirSync(join(fixture.folder, "bun.lock"));
  const run = runInputCheck(
    fixture.folder,
    ["check-licenses"],
    `
import * as cp from "node:child_process";
import { mock } from "bun:test";
const { spawnSync } = cp;
mock.module("node:child_process", () => ({
  ...cp,
  spawnSync(command, args, options) {
    if (args.includes("licenses"))
      return { status: 0, stdout: '{"MIT":[{"name":"example","license":"MIT"}]}', stderr: "example not installed" };
    return spawnSync(command, args, options);
  },
}));
`,
  );
  expect(run().stderr).toMatch(/^EISDIR:/m);
});
