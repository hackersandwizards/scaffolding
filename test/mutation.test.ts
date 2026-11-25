import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { MutationTestResult } from "mutation-testing-report-schema";
import { afterAll, assert, beforeAll, describe, expect, test, vi } from "vitest";
import { runMutation } from "../bin/scaffolding-mutation.ts";
import { limit } from "@hackersandwizards/scaffolding/test-timeout";

function linkMutationDependencies(dir: string) {
  const root = join(import.meta.dirname, "..");
  const modules = join(dir, "node_modules");
  const scope = join(modules, "@hackersandwizards");
  mkdirSync(scope, { recursive: true });
  symlinkSync(root, join(scope, "scaffolding"));
  for (const entry of [".bin", "@stryker-mutator", "vitest"])
    symlinkSync(join(root, "node_modules", entry), join(modules, entry));
}

const bun = realpathSync(process.execPath);
const nativeNodePath = process.env.PATH?.split(delimiter)
  .filter((dir) => {
    const node = join(dir, "node");
    return !existsSync(node) || realpathSync(node) !== bun;
  })
  .join(delimiter);

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

test(
  "the shared Stryker and Vitest configs run a consumer property in a Node dry run",
  { timeout: limit(30_000) },
  () => {
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
      const run = spawnSync(
        process.execPath,
        ["--no-env-file", join(root, "bin/scaffolding-mutation.ts"), "--dryRunOnly"],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: [join(dir, "node_modules", ".bin"), nativeNodePath].join(delimiter),
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
  },
);

test(
  "the mutation command runs a Bun-only Vitest suite in Bun mode",
  { timeout: limit(30_000) },
  () => {
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
  },
);

describe("mutation reporting for module-level survivors", () => {
  type Run = { status: number | null; stdout: string; stderr: string };
  type Mutant = MutationTestResult["files"][string]["mutants"][number];
  const heading = "Not tested against the full suite (module-level code)";
  let dir: string;
  let limited: Run;
  let dryRun: Run;
  let full: Run;
  let staticSurvivor: Mutant | undefined;
  let staticKill: Mutant | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "scaffolding-mutation-test-"));
    linkMutationDependencies(dir);
    writeFileSync(
      join(dir, "sample.ts"),
      `export const initial = "expected";
export const runtime = () => "runtime";`,
    );
    writeFileSync(
      join(dir, "sample.test.ts"),
      `import { expect, test } from "vitest";
import { initial, runtime } from "./sample.ts";
test("checks the initial and runtime values", () => {
  expect(initial).toBe("expected");
  expect(runtime()).toBe("runtime");
});`,
    );
    writeFileSync(
      join(dir, "loader.test.ts"),
      `import { expect, test } from "vitest";
test("loads the module without checking the value", async () => {
  expect(typeof (await import("./sample.ts")).initial).toBe("string");
});`,
    );
    const configFile = join(dir, "stryker.config.mjs");
    const config = `import base from "@hackersandwizards/scaffolding/stryker";
export default { ...base, incremental: false, mutate: ["sample.ts"]`;
    writeFileSync(configFile, `${config} };`);
    const run = (...args: string[]): Run => {
      const result = spawnSync(
        process.execPath,
        ["--no-env-file", join(import.meta.dirname, "../bin/scaffolding-mutation.ts"), ...args],
        {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, PATH: "/usr/bin:/bin", SCAFFOLDING_MUTATION_BUN: "1" },
        },
      );
      return result;
    };
    const initialMutant = () => {
      const report = JSON.parse(
        readFileSync(join(dir, ".stryker-reports/mutation.json"), "utf8"),
      ) as MutationTestResult;
      return report.files["sample.ts"].mutants.find((mutant) => mutant.location.start.line === 1);
    };

    limited = run();
    staticSurvivor = initialMutant();
    dryRun = run("--dryRunOnly");
    writeFileSync(configFile, `${config}, ignoreStatic: false };`);
    full = run();
    staticKill = initialMutant();
  }, limit(30_000));

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("the default run reports the module-level mutant as surviving its one covering test", () => {
    expect(limited.status, limited.stdout + limited.stderr).toBe(0);
    assert(staticSurvivor, "the default run should report the initial mutant");
    expect({
      static: staticSurvivor.static,
      status: staticSurvivor.status,
      coveredBy: staticSurvivor.coveredBy?.length,
    }).toEqual({
      static: true,
      status: "Survived",
      coveredBy: 1,
    });
  });

  test("the mutation command reports static survivors separately from its adjusted score", () => {
    expect(limited.stdout).toMatch(/All files[^\n]+33\.33[\s\S]+Done in/);
    expect(limited.stdout.slice(limited.stdout.indexOf("Done in"))).toContain(`${heading}: 2`);
    const survivors = limited.stdout.split(heading)[1];
    expect(survivors).toContain("sample.ts:1 StringLiteral");
    expect(survivors).toContain("sample.ts:2 ArrowFunction");
    expect(limited.stdout).toContain(
      "Mutation score excluding these survivors: 100.00% (Stryker: 33.33%)",
    );
  });

  test("testing static mutants against the full suite kills the same mutant outside its covering test", () => {
    expect(full.status, full.stdout + full.stderr).toBe(0);
    assert(staticSurvivor, "the default run should report the initial mutant");
    assert(staticKill, "the full run should report the initial mutant");
    expect({
      static: staticKill.static,
      status: staticKill.status,
      location: staticKill.location,
      coveredBy: staticKill.coveredBy?.length,
      killedBy: staticKill.killedBy?.length,
    }).toEqual({
      static: true,
      status: "Killed",
      location: staticSurvivor.location,
      coveredBy: 1,
      killedBy: 1,
    });
    expect(staticKill.coveredBy).not.toContain(staticKill.killedBy?.[0]);
    expect(full.stdout).not.toContain(heading);
  });

  test("a dry run omits the module-level survivor summary", () => {
    expect(dryRun.status, dryRun.stdout + dryRun.stderr).toBe(0);
    expect(dryRun.stdout).not.toContain(heading);
  });
});
