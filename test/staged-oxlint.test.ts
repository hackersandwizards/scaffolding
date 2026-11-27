import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  prepareStagedOxlintConfig,
  runStagedOxlint,
  stagedOxlintInputs,
} from "../lib/staged-oxlint.ts";
import { parseOxlintConfig } from "../lib/oxlint-restrictions.ts";
import { installCleanGitEnvHooks } from "./git-env.ts";

installCleanGitEnvHooks();

test("Oxlint config keeps rules with comments and a trailing comma", () => {
  const config = '// fixture\n{"rules":{"no-debugger":"error",}}';
  expect(parseOxlintConfig(config)).toEqual({ rules: { "no-debugger": "error" } });
});

test("Oxlint config rejects a double comma", () => {
  expect(() => parseOxlintConfig('// fixture\n{"rules":{"no-debugger":"error",,}}')).toThrow(
    /PropertyNameExpected/,
  );
});

test("prepareStagedOxlintConfig turns off typeAware and typeCheck while keeping other options", () => {
  const prepared = JSON.parse(
    prepareStagedOxlintConfig('{"options":{"typeAware":true,"typeCheck":true},"rules":{}}'),
  ) as { options: { typeAware: boolean; typeCheck: boolean } };
  expect(prepared.options).toEqual({ typeAware: false, typeCheck: false });
});

test.each(['{"options":{"typeAware":false}}', '{"rules":{}}'])(
  "prepareStagedOxlintConfig rejects config without typeAware: true (%s)",
  (raw) => {
    expect(() => prepareStagedOxlintConfig(raw)).toThrow("options.typeAware must be true");
  },
);

const PACKAGED_EXTENDS = [
  ".",
  "node_modules",
  "@hackersandwizards",
  "scaffolding/config/oxlint.json",
].join("/");

test.each([
  {
    baseExtends: PACKAGED_EXTENDS,
    paths: ["src/a.ts"],
    expected: [".oxlintrc.json", "src/a.ts"],
  },
  {
    baseExtends: "./config/oxlint.json",
    paths: ["src/a.ts"],
    expected: [".oxlintrc.json", "src/a.ts", "config/oxlint.json"],
  },
])("stagedOxlintInputs resolves $baseExtends", ({ baseExtends, paths, expected }) => {
  expect(stagedOxlintInputs(baseExtends, paths)).toEqual(expected);
});

test("runStagedOxlint returns 1 when .oxlintrc.json is a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "staged-oxlint-test-"));
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir, env: process.env });
    writeFileSync(
      join(dir, "target.json"),
      '{"extends":["./config/oxlint.json"],"options":{"typeAware":true}}',
    );
    symlinkSync("target.json", join(dir, ".oxlintrc.json"));
    writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
    spawnSync("git", ["add", ".oxlintrc.json", "target.json", "a.ts"], {
      cwd: dir,
      env: process.env,
    });
    const code = runStagedOxlint(dir, ["a.ts"]);
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("must be a regular file"));
  } finally {
    stderr.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
