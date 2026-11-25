import { fc, test } from "@hackersandwizards/scaffolding/property";
import { describe, expect } from "vitest";
import { fastSteps, selectChangedSteps, validGlob } from "../lib/changed-steps.ts";

const name = fc.stringMatching(/^[a-z]{1,10}$/);
const path = fc
  .tuple(fc.constantFrom("src", "docs", "fixtures", "unmapped"), name, fc.constantFrom("md", "ts"))
  .map(([dir, file, ext]) => `${dir}/${file}.${ext}`);
const paths = fc.array(path);
const available = [
  "format",
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
  selectChangedSteps(
    files,
    fastSteps(available, new Map(fullOnly.map((step) => [step, "builds"]))),
    local,
    mappings,
  );

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

test.prop([fc.array(mapped), full], {
  examples: [
    [[["docs", "a"]], []],
    [[["src", "a"]], []],
  ],
})(
  "mapped paths select their steps, the always-on checks, and no unrelated steps",
  (files, fullOnly) => {
    const named = files.map(([dir, file]) =>
      dir === "src" ? `src/${file}.ts` : `docs/${file}.md`,
    );
    const expected = new Map([
      ["format", "runs on every changed check"],
      ["check:general", "no path scope configured"],
    ]);
    for (const file of named) {
      const steps = file.startsWith("docs/") ? ["check:docs"] : ["check:source", "lint", "test"];
      for (const step of steps)
        if (!expected.has(step)) expected.set(step, `matches ${JSON.stringify(file)}`);
    }
    for (const step of fullOnly) expected.delete(step);
    expect(select(named, fullOnly)).toEqual({ steps: expected });
  },
);

test.prop([fc.constantFrom("src/package.json", "docs/yarn.lock", ".githooks/pre-push"), full])(
  "shared configuration paths select exactly the fast steps",
  (file, fullOnly) => {
    const result = select([file], fullOnly);
    expect(result.fallback).toBe(`${JSON.stringify(file)} is a shared configuration path`);
    expect(new Set(result.steps.keys())).toEqual(
      new Set(available.filter((step) => !fullOnly.includes(step))),
    );
  },
);

type GlobInput = (base: string, first: string, second: string, invalid: string) => string;
const globCases: [string, GlobInput, boolean][] = [
  ["plain path", (base) => base, true],
  ["braces and a class", (base, first, second) => `${base}/{${first},${second}}/[ab]*`, true],
  ["unclosed brace", (base, first, second) => `${base}/{${first},${second}`, false],
  ["extra closing brace", (base, first, second) => `${base}/${first},${second}}`, false],
  ["unclosed class", (base) => `${base}/[ab`, false],
  ["reversed braces", (base) => `${base}/}{`, false],
  ["NUL", (base) => `${base}/a\0b`, false],
  ["escaped brace and a class", (base) => `${base}/[{]\\}`, true],
  ["trailing escape", (base) => `${base}/a\\`, false],
  ["invalid path segment", (base, first, _second, invalid) => `${base}/${invalid}/${first}`, false],
];

describe.each(globCases)("changed glob with %s", (_, glob, accepted) => {
  test.prop([fc.array(name, { minLength: 1 }), name, name, fc.constantFrom("", ".", "..")])(
    "classifies the generated pattern",
    (segments, first, second, invalid) => {
      const pattern = glob(segments.join("/"), first, second, invalid);
      expect(validGlob(pattern), pattern).toBe(accepted);
    },
  );
});
