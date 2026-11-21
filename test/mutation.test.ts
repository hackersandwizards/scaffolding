import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test, vi } from "vitest";
import { runMutation } from "../bin/scaffolding-mutation.ts";

function linkMutationDependencies(dir: string) {
  const root = join(import.meta.dirname, "..");
  const modules = join(dir, "node_modules");
  const scope = join(modules, "@hackersandwizards");
  mkdirSync(scope, { recursive: true });
  symlinkSync(root, join(scope, "scaffolding"));
  for (const entry of [".bin", "@stryker-mutator", "vitest"])
    symlinkSync(join(root, "node_modules", entry), join(modules, entry));
}

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

test("the shared Stryker and Vitest configs run a consumer property in a Node dry run", () => {
  const dir = mkdtempSync(join(tmpdir(), "scaffolding-mutation-test-"));
  try {
    const root = join(import.meta.dirname, "..");
    linkMutationDependencies(dir);
    writeFileSync(join(dir, "package.json"), '{"name":"mutation-consumer","type":"module"}');
    writeFileSync(join(dir, "sample.ts"), "export const double = (value: number) => value * 2;");
    writeFileSync(
      join(dir, "sample.prop.test.ts"),
      `import { fc, test } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";
import { double } from "./sample.ts";
test.prop([fc.integer({ min: 1, max: 100 })])("doubles its input", (value) => {
  expect(process.versions.bun).toBeUndefined();
  expect(fc.readConfigureGlobal().numRuns).toBe(12);
  expect(double(value)).toBe(value + value);
});`,
    );
    writeFileSync(
      join(dir, "vitest.config.mjs"),
      'export { default } from "@hackersandwizards/scaffolding/vitest";\n',
    );
    writeFileSync(
      join(dir, "stryker.config.mjs"),
      `import base from "@hackersandwizards/scaffolding/stryker";
export default { ...base, incremental: false, reporters: ["clear-text"], mutate: ["sample.ts"] };`,
    );
    const bun = realpathSync(process.execPath);
    const path = process.env.PATH?.split(delimiter)
      .filter((dir) => {
        const node = join(dir, "node");
        return !existsSync(node) || realpathSync(node) !== bun;
      })
      .join(delimiter);
    const run = spawnSync(
      process.execPath,
      ["--no-env-file", join(root, "bin/scaffolding-mutation.ts"), "--dryRunOnly"],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: [join(dir, "node_modules", ".bin"), path].join(delimiter),
          SCAFFOLDING_MUTATION_BUN: undefined,
        },
      },
    );
    const output = run.stdout + run.stderr;
    expect(run.status, output).toBe(0);
    expect(output).toMatch(/Initial test run succeeded\. Ran 1 tests/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the mutation command runs a Bun-only Vitest suite in Bun mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "scaffolding-mutation-test-"));
  try {
    const root = join(import.meta.dirname, "..");
    linkMutationDependencies(dir);
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
      `import base from "@hackersandwizards/scaffolding/stryker";
export default {
      ...base,
      incremental: false,
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
