import { expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInputCheck } from "./preloaded-check.ts";
import { testDirectory } from "./test-directory.ts";

const licenseWarning = "warn: 1 package in bun.lock is not installed and was skipped";
const licensePreload = `
import * as cp from "node:child_process";
import { mock } from "bun:test";
const { spawnSync } = cp;
mock.module("node:child_process", () => ({
  ...cp,
  spawnSync(command, args, options) {
    if (command === "git" && args[0] === "rev-parse")
      return { status: 0, stdout: Buffer.from(options.cwd) };
    if (args.includes("licenses"))
      return { status: 0, stdout: '{"MIT":[{"name":"example","license":"MIT"}]}', stderr: ${JSON.stringify(licenseWarning)} };
    return spawnSync(command, args, options);
  },
}));
`;

test("check-licenses lets an unexpected lockfile read error surface", () => {
  using fixture = testDirectory();
  mkdirSync(join(fixture.folder, "bun.lock"));
  const run = runInputCheck(fixture.folder, ["check-licenses"], licensePreload);
  expect(run().stderr).toMatch(/^EISDIR:/m);
});

test.each([
  { kind: "bundled", metadata: { bundled: true }, status: 0, diagnostic: "" },
  {
    kind: "non-bundled",
    metadata: {},
    status: 1,
    diagnostic: `[check-licenses] ${licenseWarning}: example/runtime/leaf needed, run bun install`,
  },
])("checks missing dependencies of a $kind package", ({ metadata, status, diagnostic }) => {
  using fixture = testDirectory();
  mkdirSync(join(fixture.folder, "node_modules/example/node_modules/runtime"), { recursive: true });
  writeFileSync(
    join(fixture.folder, "bun.lock"),
    JSON.stringify({
      workspaces: { "": { dependencies: { example: "1.0.0" } } },
      packages: {
        example: ["example@1.0.0", "", { optionalDependencies: { runtime: "1.0.0" } }],
        "example/runtime": ["runtime@1.0.0", "", { dependencies: { leaf: "1.0.0" }, ...metadata }],
        "example/runtime/leaf": ["leaf@1.0.0", "", {}],
      },
    }),
  );
  const result = runInputCheck(fixture.folder, ["check-licenses"], licensePreload)();
  expect(result.status, result.stderr).toBe(status);
  expect(result.stderr.split("\n")[0]).toBe(diagnostic);
});
