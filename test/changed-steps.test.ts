import { expect, test } from "vitest";
import {
  changedPathReasons,
  ChangedStepSelector,
  configuredPathMatches,
} from "../lib/changed-steps.ts";
import { validGlob } from "../lib/repo-inputs.ts";

test.each([[" ", false]])("classifies the fixed changed glob %j", (glob, accepted) => {
  expect(validGlob(glob)).toBe(accepted);
});

test.each([["src/package.json", '"src/package.json" is a shared configuration path']])(
  "recognizes configuration before checking custom path matches",
  (path, expected) => {
    expect(
      configuredPathMatches(path, [{ glob: new Bun.Glob("src/**"), steps: ["check:src"] }]),
    ).toBe(expected);
  },
);

test.each([
  [
    "hooks/post-update",
    [
      'matches shell shebang in "hooks/post-update"',
      'sources "hooks/post-update"',
      'matches "hooks/post-update"',
    ],
  ],
])("reports shebang, source and mapped reasons in precedence order", (path, expected) => {
  const paths = new Set([path]);
  const changes = { paths, shellShebangs: paths, sourcedPaths: paths, since: "HEAD" };
  const reasons = changedPathReasons(
    path,
    [{ glob: new Bun.Glob("hooks/**"), steps: ["shell"] }],
    changes,
  );
  expect([...reasons].map(({ reason }) => reason)).toEqual(expected);
});

test.each([
  [
    "hooks/post-update",
    [
      ["format", "runs on every changed check"],
      ["check:plain", "no path scope configured"],
      ["shell", 'matches shell shebang in "hooks/post-update"'],
      ["check:hooks", 'matches "hooks/post-update"'],
    ],
  ],
])("inserts steps in check order and retains their first reason", (path, expected) => {
  const paths = new Set([path]);
  const selector = new ChangedStepSelector(
    new Set(["shell", "check:plain", "check:hooks", "format"]),
    ["check:hooks", "check:plain"],
    [{ glob: new Bun.Glob("hooks/**"), steps: ["check:hooks", "shell"] }],
  );
  expect([
    ...selector.select({ paths, shellShebangs: paths, sourcedPaths: paths, since: "HEAD" }).steps,
  ]).toEqual(expected);
});

test.each([
  ["probe.pyi", "python"],
  [".ruff.toml", "python"],
  ["infra/main.tfvars", "terraform"],
  [".tflint.hcl", "terraform"],
  ["ops/sidecar.dOcKeRfIlE", "dockerfile"],
  [".hadolint.yml", "dockerfile"],
  [".github/actionlint.yaml", "workflows"],
])("selects the language or infrastructure step for %s", (path, step) => {
  const selector = new ChangedStepSelector(
    new Set(["python", "terraform", "dockerfile", "workflows"]),
    [],
    [],
  );
  const result = selector.select({
    paths: new Set([path]),
    shellShebangs: new Set(),
    sourcedPaths: new Set(),
    since: "HEAD",
  });
  expect(result).toEqual({ steps: new Map([[step, `matches ${JSON.stringify(path)}`]]) });
});

test.each([
  ["main.py", ["python", "test"]],
  ["main.pyi", ["python", "test"]],
  ["pyproject.toml", ["python", "test"]],
  [".ruff.toml", ["python"]],
  ["ruff.toml", ["python"]],
] as const)("selects the Python steps for %s", (path, steps) => {
  const selector = new ChangedStepSelector(new Set(["python", "test"]), [], []);
  const result = selector.select({
    paths: new Set([path]),
    shellShebangs: new Set(),
    sourcedPaths: new Set(),
    since: "HEAD",
  });
  expect(result).toEqual({
    steps: new Map(steps.map((step) => [step, `matches ${JSON.stringify(path)}`])),
  });
});

test.each([
  ["lib/code.ts", ["duplicates", "unused"]],
  ["browser.js", ["duplicates", "unused"]],
  ["package.json", ["duplicates", "unused"]],
  ["src/Page.astro", ["unused"]],
  ["src/styles.css", ["unused"]],
] as const)("selects code audits for %s", (path, expected) => {
  const selector = new ChangedStepSelector(new Set(["duplicates", "unused"]), [], []);
  const result = selector.select({
    paths: new Set([path]),
    shellShebangs: new Set(),
    sourcedPaths: new Set(),
    since: "HEAD",
  });
  expect([...result.steps.keys()]).toEqual(expected);
});
