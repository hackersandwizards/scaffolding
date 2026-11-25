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

test.prop([fc.array(name, { minLength: 1 }), name, name, fc.constantFrom("", ".", "..")])(
  "changed globs accept braces and classes and reject malformed patterns and segments",
  (segments, first, second, invalid) => {
    const base = segments.join("/");
    for (const [glob, accepted] of [
      [base, true],
      [`${base}/{${first},${second}}/[ab]*`, true],
      [`${base}/{${first},${second}`, false],
      [`${base}/${first},${second}}`, false],
      [`${base}/[ab`, false],
      [`${base}/}{`, false],
      [`${base}/a\0b`, false],
      [" ", false],
      [`${base}/[{]\\}`, true],
      [`${base}/a\\`, false],
      [`${base}/${invalid}/${first}`, false],
    ] as const)
      expect(validGlob(glob), glob).toBe(accepted);
  },
);
