import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import {
  actionlintPin,
  hadolintPin,
  ruffPin,
  shellcheckPin,
  terraformPin,
  tflintPin,
  type BinaryRelease,
} from "../lib/pinned-binary-assets.ts";
import { pinnedBinary } from "../lib/pinned-binary.ts";
import { testDirectory } from "./test-directory.ts";

const root = join(import.meta.dirname, "..");
const preload = join(import.meta.dirname, "extra-lint-preload.ts");
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function lintFixtureGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function addLintFixture(cwd: string, name: string, source: string) {
  const path = join(cwd, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  lintFixtureGit(cwd, ["add", "--", name]);
}

function runLintFixture(cwd: string, step: string, binaries?: Record<string, string>) {
  if (step === "styles" && binaries !== undefined) {
    const binDir = join(cwd, "node_modules/.bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(root, "node_modules/stylelint/bin/stylelint.mjs"), join(binDir, "stylelint"));
  }
  const script = step === "styles" ? "check-styles.ts" : "scaffolding.ts";
  const args = step === "styles" ? [] : [step];
  const result = spawnSync(
    process.execPath,
    ["--no-env-file", join(root, "bin", script), ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...gitEnv,
        PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}`,
        BUN_OPTIONS: `--preload=${preload}`,
        SCAFFOLDING_TEST_BINARIES: JSON.stringify(binaries ?? {}),
      },
    },
  );
  return { code: result.status, output: result.stdout + result.stderr };
}

type LintFixture = {
  step: string;
  path: string;
  description: string;
  pins: [string, BinaryRelease][];
  bad: string;
  green: string;
  findings: RegExp;
  guide: string;
};

const workflow = (runner: string) => `name: Test
on: push
jobs:
  test:
    runs-on: ${runner}
    steps:
      - run: echo ok
`;

const lintFixtures: LintFixture[] = [
  {
    step: "python",
    path: "main.pyi",
    description: "Python files",
    pins: [["ruff", ruffPin]],
    bad: "import os\n\nx:int=1\n",
    green: "x: int = 1\n",
    findings: /F401[^\n]*\n[\s\S]*unformatted: File would be reformatted/,
    guide: "ruff",
  },
  {
    step: "terraform",
    path: "module/main.tf",
    description: "Terraform files",
    pins: [
      ["terraform", terraformPin],
      ["tflint", tflintPin],
    ],
    bad: 'variable "unused" {\n  type=string\n}\n',
    green: 'terraform {\n  required_version = ">= 1.0"\n}\n',
    findings: /\+ {2}type = string[\s\S]*terraform_unused_declarations/,
    guide: "tflint",
  },
  {
    step: "dockerfile",
    path: "example.cOnTaInEr/Dockerfile.example",
    description: "Dockerfiles",
    pins: [["hadolint", hadolintPin]],
    bad: "FROM alpine:3.23\nRUN echo first\nRUN echo second\n",
    green: "FROM alpine:3.23\nRUN echo ok\n",
    findings: /DL3059 info/,
    guide: "hadolint",
  },
  {
    step: "workflows",
    path: ".github/workflows/test.yaml",
    description: "GitHub Actions workflows",
    pins: [
      ["actionlint", actionlintPin],
      ["shellcheck", shellcheckPin],
    ],
    bad: workflow("ubuntu-latset"),
    green: workflow("ubuntu-latest"),
    findings: /ubuntu-latset[^\n]*\[runner-label\]/,
    guide: "actionlint",
  },
  {
    step: "styles",
    path: "main.css",
    description: "CSS or Astro files",
    pins: [],
    bad: "a { colro: red; }\n",
    green: "a { color: var(--unknown-without-brand); }\n",
    findings: /Unknown property "colro" \(property-no-unknown\)/,
    guide: "property-no-unknown",
  },
];

function initLintFixture(folder: string, fixture: LintFixture) {
  lintFixtureGit(folder, ["init", "-q"]);
  if (fixture.step === "styles") {
    writeFileSync(join(folder, "package.json"), '{"type":"module"}\n');
    const config = JSON.stringify(join(root, "config/stylelint.js"));
    writeFileSync(
      join(folder, "stylelint.config.js"),
      `import styles from ${config};\nexport default styles();\n`,
    );
  }
}

describe.each(lintFixtures)("$step", (fixture) => {
  let binaries: Record<string, string>;

  beforeAll(async () => {
    binaries = {};
    for (const [tool, release] of fixture.pins)
      binaries[tool] = await pinnedBinary(root, tool, release);
  }, 90_000);

  test("fails on the planted finding and prints its guide", () => {
    using repo = testDirectory();
    initLintFixture(repo.folder, fixture);
    addLintFixture(repo.folder, fixture.path, fixture.bad);
    const result = runLintFixture(repo.folder, fixture.step, binaries);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toMatch(fixture.findings);
    expect(result.output).toContain(`[guide] ${fixture.guide}:`);
  });

  test("passes on tracked clean input", () => {
    using repo = testDirectory();
    initLintFixture(repo.folder, fixture);
    addLintFixture(repo.folder, fixture.path, fixture.green);
    const result = runLintFixture(repo.folder, fixture.step, binaries);
    expect(result.code, result.output).toBe(0);
  });

  test("does not lint untracked input or request a binary", () => {
    using repo = testDirectory();
    initLintFixture(repo.folder, fixture);
    const input = join(repo.folder, fixture.path);
    mkdirSync(dirname(input), { recursive: true });
    writeFileSync(input, fixture.bad);
    const result = runLintFixture(repo.folder, fixture.step);
    expect(result).toEqual({
      code: 0,
      output: `[${fixture.step}] no tracked ${fixture.description}\n`,
    });
    expect(existsSync(join(repo.folder, "node_modules"))).toBe(false);
  });
});
