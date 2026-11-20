import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runMutation } from "../bin/scaffolding-mutation.ts";

test("stops a hung mutation command at the wall limit and tells the caller how to narrow it", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(await runMutation([process.execPath, "-e", "setInterval(() => {}, 1000)"], 25)).toBe(
      124,
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/15-minute wall limit.*--mutate <files>/),
    );
  } finally {
    stderr.mockRestore();
  }
});

test("returns the mutation command's exit status when it finishes before the limit", async () => {
  expect(await runMutation([process.execPath, "-e", "process.exit(7)"])).toBe(7);
});

test("the mutation command runs a Bun-only Vitest suite in Bun mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "scaffolding-mutation-test-"));
  try {
    const root = join(import.meta.dirname, "..");
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
    writeFileSync(
      join(dir, "sample.ts"),
      'export const match = (file: string) => new Bun.Glob("*.ts").match(file);',
    );
    writeFileSync(
      join(dir, "sample.test.ts"),
      `
import { expect, test } from "vitest";
import { match } from "./sample.ts";
test("matches a TypeScript file using Bun.Glob", () => expect(match("sample.ts")).toBe(true));`,
    );
    writeFileSync(
      join(dir, "stryker.config.mjs"),
      `export default {
      testRunner: "vitest",
      vitest: { pool: "forks", related: false },
      reporters: ["clear-text"],
      mutate: ["sample.ts"],
    };`,
    );
    const run = spawnSync(
      process.execPath,
      ["--no-env-file", join(root, "bin/scaffolding-mutation.ts")],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: "/usr/bin:/bin", SCAFFOLDING_MUTATION_BUN: "1" },
      },
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout + run.stderr).toMatch(/Instrumented 1 source file\(s\) with [1-9]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
