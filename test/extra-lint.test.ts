import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

const workflowJob = (name: string, runner: string) => `  ${name}:
    runs-on: ${runner}
    steps:
      - run: echo ok
`;
const workflow = (runner: string) => `name: Test\non: push\njobs:\n${workflowJob("test", runner)}`;

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

test("scaffolding fix leaves tracked Python unchanged when python is skipped", () => {
  using repo = testDirectory();
  lintFixtureGit(repo.folder, ["init", "-q"]);
  const source = "x=1\n";
  addLintFixture(repo.folder, "main.py", source);
  writeFileSync(
    join(repo.folder, "package.json"),
    JSON.stringify({ scaffolding: { skip: { python: "fixture skips Ruff" } } }),
  );
  const tools = join(repo.folder, "node_modules/.bin");
  mkdirSync(tools, { recursive: true });
  for (const tool of ["eslint", "prettier"])
    writeFileSync(join(tools, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const ruff = join(tools, "ruff");
  writeFileSync(ruff, '#!/bin/sh\nif [ "$1" = format ]; then printf "x = 1\\n" > main.py; fi\n', {
    mode: 0o755,
  });

  const result = runLintFixture(repo.folder, "fix", { ruff });
  expect(result.code, result.output).toBe(0);
  expect(readFileSync(join(repo.folder, "main.py"), "utf8")).toBe(source);
});

test.each([
  [">3.10", "py311"],
  [">=3.9,<4,!=3.9.*,!=3.10.*", "py311"],
  [">=3.10,<4", "py310"],
  [">=3.10,!=3.10.1", "py310"],
] as const)("Python target resolver maps %s to %s", (requires, target) => {
  using repo = testDirectory();
  lintFixtureGit(repo.folder, ["init", "-q"]);
  addLintFixture(repo.folder, "main.py", "x = 1\n");
  addLintFixture(repo.folder, "pyproject.toml", `[project]\nrequires-python = "${requires}"\n`);
  const ruff = join(repo.folder, "ruff");
  writeFileSync(
    ruff,
    '#!/bin/sh\nwhile [ "$1" != --target-version ]; do shift; done\nprintf "%s\\n" "$2"\n',
    { mode: 0o755 },
  );

  const result = runLintFixture(repo.folder, "python", { ruff });
  expect(result).toEqual({ code: 0, output: `${target}\n${target}\n` });
});

describe("python target version", () => {
  const file = "main.py";
  const utc = "import datetime\n\nNOW = datetime.timezone.utc\n";
  let binaries: Record<string, string>;

  beforeAll(async () => {
    binaries = { ruff: await pinnedBinary(root, "ruff", ruffPin) };
  }, 90_000);

  test("accepts datetime.timezone.utc without Ruff config", () => {
    using repo = testDirectory();
    lintFixtureGit(repo.folder, ["init", "-q"]);
    addLintFixture(repo.folder, file, utc);
    const result = runLintFixture(repo.folder, "python", binaries);
    expect(result.code, result.output).toBe(0);
  });

  test("reports FA102 for a union annotation without Ruff config", () => {
    using repo = testDirectory();
    lintFixtureGit(repo.folder, ["init", "-q"]);
    addLintFixture(repo.folder, file, "def f(x: int | None) -> None:\n    pass\n");
    const result = runLintFixture(repo.folder, "python", binaries);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain("FA102");
  });

  test("reports UP017 when the project requires Python 3.11", () => {
    using repo = testDirectory();
    lintFixtureGit(repo.folder, ["init", "-q"]);
    addLintFixture(repo.folder, "pyproject.toml", '[project]\nrequires-python = ">=3.11"\n');
    addLintFixture(repo.folder, file, utc);
    const result = runLintFixture(repo.folder, "python", binaries);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain("UP017");

    addLintFixture(repo.folder, "pyproject.toml", '[project]\nrequires-python = ">=3.10,<4"\n');
    const olderTarget = runLintFixture(repo.folder, "python", binaries);
    expect(olderTarget.code, olderTarget.output).toBe(0);
  });
});

describe("workflows runner labels", () => {
  const file = ".github/workflows/test.yaml";
  const repoConfig = "self-hosted-runner:\n  labels: [local-arm]\nconfig-variables: []\n";
  let binaries: Record<string, string>;

  beforeAll(async () => {
    binaries = {
      actionlint: await pinnedBinary(root, "actionlint", actionlintPin),
      shellcheck: await pinnedBinary(root, "shellcheck", shellcheckPin),
    };
  }, 90_000);

  test.each(["ubuntu-26.04", "ubuntu-26.04-arm"])("accepts %s", (label) => {
    using repo = testDirectory();
    lintFixtureGit(repo.folder, ["init", "-q"]);
    addLintFixture(repo.folder, file, workflow(label));
    const result = runLintFixture(repo.folder, "workflows", binaries);
    expect(result.code, result.output).toBe(0);
  });

  test("rejects an unknown hosted runner label", () => {
    using repo = testDirectory();
    lintFixtureGit(repo.folder, ["init", "-q"]);
    addLintFixture(repo.folder, file, workflow("ubuntu-99.04"));
    const result = runLintFixture(repo.folder, "workflows", binaries);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toMatch(/ubuntu-99\.04[^\n]*\[runner-label\]/);
  });

  test.each(["yaml", "yml"])("merges repository labels and settings from actionlint.%s", (ext) => {
    using repo = testDirectory();
    lintFixtureGit(repo.folder, ["init", "-q"]);
    const config = `.github/actionlint.${ext}`;
    addLintFixture(repo.folder, config, repoConfig);
    const jobs = workflow("ubuntu-26.04-arm") + workflowJob("local", "[self-hosted, local-arm]");
    addLintFixture(repo.folder, file, jobs);
    const valid = runLintFixture(repo.folder, "workflows", binaries);
    expect(valid.code, valid.output).toBe(0);
    expect(readFileSync(join(repo.folder, config), "utf8")).toBe(repoConfig);

    addLintFixture(repo.folder, file, jobs.replace("echo ok", "echo ${{ vars.UNDECLARED }}"));
    const invalid = runLintFixture(repo.folder, "workflows", binaries);
    expect(invalid.code, invalid.output).not.toBe(0);
    expect(invalid.output).toMatch(/no configuration variable is allowed[^\n]*\[expression\]/);
  });
});
