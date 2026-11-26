import { expect, test } from "vitest";
import {
  changedPathReasons,
  ChangedStepSelector,
  configuredPathMatches,
  validGlob,
} from "../lib/changed-steps.ts";

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
