import { fc, test } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";
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
const local = ["check:docs", "check:source", "check:general"];
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

test.prop([paths, paths, full])("adding paths only adds fast steps", (files, more, fullOnly) => {
  const selected = select(files, fullOnly).steps;
  const extended = select([...files, ...more], fullOnly).steps;
  expect([...selected.keys()].every((step) => extended.has(step))).toBe(true);
  expect(fullOnly.some((step) => extended.has(step))).toBe(false);
});

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

test.prop([fc.array(name, { minLength: 1 }), name, name, fc.constantFrom("", ".", "..")])(
  "changed globs accept braces and classes and reject malformed patterns and segments",
  (segments, first, second, invalid) => {
    expect(validGlob(segments.join("/"))).toBe(true);
    const base = segments.join("/");
    expect(validGlob(`${base}/{${first},${second}}/[ab]*`)).toBe(true);
    expect(validGlob(`${base}/{${first},${second}`)).toBe(false);
    expect(validGlob(`${base}/${first},${second}}`)).toBe(false);
    expect(validGlob(`${base}/[ab`)).toBe(false);
    expect(validGlob(`${base}/${invalid}/${first}`)).toBe(false);
  },
);
