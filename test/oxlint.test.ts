import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  importRestrictionGuidance,
  oxlintConfiguration,
  syntaxRestrictionGuidance,
  validateOxlintRuntimeOptions,
} from "../lib/oxlint.ts";
import template from "../template/.oxlintrc.json";
import { runTool } from "./preloaded-check.ts";
import { testDirectory } from "./test-directory.ts";

test.each([
  [
    { options: { typeAware: false }, ignorePatterns: 4, plugins: null },
    "options.typeAware must be true for Oxlint to run the typed rules. Set it to true in .oxlintrc.json.",
  ],
])("reports invalid runtime options before ignored paths and plugin errors", (input, expected) => {
  expect(() => validateOxlintRuntimeOptions(input)).toThrow(expected);
});

test.each([
  [
    "ignorePatterns",
    [],
    "ignorePatterns must include the shared exclusions so Oxlint scans the intended files. Set it in .oxlintrc.json to an array of strings that includes the skeleton's ignorePatterns entries.",
  ],
  [
    "plugins",
    [],
    'plugins must include "typescript" for Oxlint to run the shared typed rules. Set plugins in .oxlintrc.json to an array that includes "typescript".',
  ],
])("explains invalid %s", (key, value, expected) => {
  expect(() => validateOxlintRuntimeOptions({ ...template, [key]: value })).toThrow(expected);
});

test.each([
  [
    "env",
    {},
    "env must enable the shared runtime globals so Oxlint can check references. Set env.browser, env.node and env.bun to true in .oxlintrc.json.",
  ],
  [
    "extends",
    [],
    `extends must load the shared Oxlint rules. Set extends in .oxlintrc.json to ["${template.extends[0]}"].`,
  ],
])("explains why .oxlintrc.json needs %s", (key, value, expected) => {
  using dir = testDirectory();
  writeFileSync(join(dir.folder, ".oxlintrc.json"), JSON.stringify({ ...template, [key]: value }));
  expect(() => oxlintConfiguration(dir.folder)).toThrow(expected);
});

test("explains why an Oxlint configuration directory cannot be read", () => {
  using dir = testDirectory();
  mkdirSync(join(dir.folder, ".oxlintrc.json"));
  expect(() => oxlintConfiguration(dir.folder)).toThrow(
    ".oxlintrc.json must be a regular file for Oxlint to read its settings. Restore the regular file from the scaffolding skeleton.",
  );
});

test.each<{
  name: string;
  selected: string;
  files: Record<string, string>;
  output: string;
  expected: string;
}>([
  {
    name: "a TypeScript file without a project",
    selected: "file.ts",
    files: { "file.ts": "export {};" },
    output: "",
    expected:
      "file.ts: Oxlint cannot run typed rules without a TypeScript project in this repository. Add a tsconfig.json in this directory or an ancestor inside the repository and include this file.",
  },
  {
    name: "an invalid selected path",
    selected: "missing.js",
    files: {},
    output: "",
    expected:
      "missing.js: Oxlint selected a path that is missing or is not a regular file. Fix the affected paths or adjust ignorePatterns in .oxlintrc.json, then rerun the check.",
  },
  {
    name: "an invalid diagnostics object",
    selected: "file.js",
    files: { "file.js": "export {};" },
    output: "{}",
    expected:
      "Oxlint's JSON diagnostics have no diagnostics array, so the check cannot print rule guides. Run bun install to restore the pinned Oxlint version and rerun the check.",
  },
])("explains $name", ({ selected, files, output, expected }) => {
  using dir = testDirectory();
  for (const [file, contents] of Object.entries(files))
    writeFileSync(join(dir.folder, file), contents);
  writeFileSync(join(dir.folder, ".oxlintrc.json"), JSON.stringify(template));
  const mock = join(dir.folder, "oxlint");
  writeFileSync(
    mock,
    `#!/bin/sh\ncase " $* " in\n*" --debug=files "*) echo "${selected}"; exit 0;;\n*" -f json "*) echo "${output}";;\nesac\nexit 1\n`,
    { mode: 0o755 },
  );
  const result = runTool(
    dir.folder,
    `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(mock)} });`,
    [join(import.meta.dirname, "../lib/oxlint.ts")],
  );
  expect(result.stderr).toBe(`[oxlint] ${expected}\n`);
});

test.each([[{ regex: "^blocked/", group: ["alternative"], message: " " }, '"^blocked/"']])(
  "reports import regexes before groups and rejects whitespace-only reasons",
  (input, expected) => {
    expect(
      [...importRestrictionGuidance("rules.no-restricted-imports", [{ patterns: [input] }])].map(
        ({ text }) => text,
      ),
    ).toEqual([expected]);
  },
);

test.each([[[{ selector: 9 }, { selector: "NewExpression", message: " " }], '"NewExpression"']])(
  "reports syntax selectors with blank reasons and ignores non-string selectors",
  (input, expected) => {
    expect(
      [...syntaxRestrictionGuidance("rules.no-restricted-syntax", input)].map(({ text }) => text),
    ).toEqual([expected]);
  },
);
