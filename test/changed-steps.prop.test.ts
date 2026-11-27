import { defined } from "@hackersandwizards/scaffolding/defined";
import { fc, test } from "@hackersandwizards/scaffolding/property";
import { describe, expect } from "vitest";
import { ChangedStepSelector, fastSteps } from "../lib/changed-steps.ts";
import { validGlob } from "../lib/repo-inputs.ts";

const name = fc.stringMatching(/^[a-z]{1,10}$/);
const path = fc
  .tuple(fc.constantFrom("src", "docs", "fixtures", "unmapped"), name, fc.constantFrom("md", "ts"))
  .map(([dir, file, ext]) => `${dir}/${file}.${ext}`);
const paths = fc.array(path);
const available = [
  "format",
  "workflows",
  "lint",
  "test",
  "check:docs",
  "check:source",
  "check:general",
  "catalog",
];
const mappings = [
  { glob: new Bun.Glob("docs/**"), steps: ["check:docs"] },
  { glob: new Bun.Glob("src/**"), steps: ["check:source"] },
];
const local = ["check:docs", "check:source", "check:general", "test"];
const full = fc.subarray(["test", "check:docs", "check:source", "catalog"]);

const select = (files: string[], fullOnly: string[]) =>
  new ChangedStepSelector(
    fastSteps(available, new Map(fullOnly.map((step) => [step, "builds"]))),
    local,
    mappings,
  ).select({
    paths: files,
    shellShebangs: new Set(),
    sourcedPaths: new Set(),
    since: "HEAD",
  });

test.prop([paths, name, full])(
  "an unmapped path selects exactly the fast steps",
  (files, unknown, fullOnly) => {
    const result = select([...files, `unmapped/${unknown}.txt`], fullOnly);
    expect(result.fallback).toContain("matches no path glob");
    expect(new Set(result.steps.keys())).toEqual(
      new Set(available.filter((step) => !fullOnly.includes(step))),
    );
  },
);

const mapped = fc.tuple(fc.constantFrom("docs", "src"), name);
const expectedScopes = {
  docs: { extension: "md", steps: ["check:docs"] },
  src: { extension: "ts", steps: ["check:source", "lint", "test"] },
};
type MappedFolder = keyof typeof expectedScopes;
const scopedPath = (folder: MappedFolder, file: string) =>
  `${folder}/${file}.${expectedScopes[folder].extension}`;

test.prop([fc.array(mapped), full], {
  examples: [
    [[["docs", "a"]], []],
    [[["src", "a"]], []],
  ],
})(
  "mapped paths select their steps, the always-on checks, and no unrelated steps",
  (files, fullOnly) => {
    const named = files.map(([folder, file]) => scopedPath(folder, file));
    const reasons = [
      ["format", "runs on every changed check"],
      ["check:general", "no path scope configured"],
      ...files.flatMap(([folder, file]) =>
        expectedScopes[folder].steps.map((step) => [
          step,
          `matches ${JSON.stringify(scopedPath(folder, file))}`,
        ]),
      ),
    ];
    const grouped = Map.groupBy(reasons, ([step]) => step);
    const expected = new Map(
      [...grouped].map(([step, entries]) => [
        step,
        defined(entries[0], "the first reason for the step")[1],
      ]),
    );
    for (const step of fullOnly) expected.delete(step);
    expect(select(named, fullOnly)).toEqual({ steps: expected });
  },
);

test.prop([
  fc.constantFrom(
    "src/package.json",
    "docs/yarn.lock",
    ".githooks/pre-push",
    ".github/workflows/build.yaml",
  ),
  full,
])("shared configuration paths select exactly the fast steps", (file, fullOnly) => {
  const result = select([file], fullOnly);
  expect(result.fallback).toBe(`${JSON.stringify(file)} is a shared configuration path`);
  expect(new Set(result.steps.keys())).toEqual(
    new Set(available.filter((step) => !fullOnly.includes(step))),
  );
});

const globParts = fc.record(
  {
    segments: fc.array(name, { minLength: 1 }),
    first: name,
    second: name,
    invalid: fc.constantFrom("", ".", ".."),
  },
  { noNullPrototype: true },
);
type GlobParts = ReturnType<typeof globParts.generate>["value"];
type GlobInput = (base: string, parts: GlobParts) => string;
const globCases: [string, GlobInput, boolean][] = [
  ["plain path", (base) => base, true],
  ["braces and a class", (base, { first, second }) => `${base}/{${first},${second}}/[ab]*`, true],
  ["unclosed brace", (base, { first, second }) => `${base}/{${first},${second}`, false],
  ["extra closing brace", (base, { first, second }) => `${base}/${first},${second}}`, false],
  ["unclosed class", (base) => `${base}/[ab`, false],
  ["reversed braces", (base) => `${base}/}{`, false],
  ["NUL", (base) => `${base}/a\0b`, false],
  ["escaped brace and a class", (base) => `${base}/[{]\\}`, true],
  ["trailing escape", (base) => `${base}/a\\`, false],
  ["invalid path segment", (base, { first, invalid }) => `${base}/${invalid}/${first}`, false],
];

describe.each(globCases)("changed glob with %s", (_, glob, accepted) => {
  test.prop([globParts])("classifies the generated pattern", (parts) => {
    const pattern = glob(parts.segments.join("/"), parts);
    expect(validGlob(pattern), pattern).toBe(accepted);
  });
});
