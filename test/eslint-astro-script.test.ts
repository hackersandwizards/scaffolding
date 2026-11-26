import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test, vi } from "vitest";
import {
  AstroScriptPrograms,
  astroBlockFile,
  astroCompilerOptions,
  compileAstroProject,
  declareAstroVariables,
  findAstroTypeScriptProject,
  remapAstroVariableMessages,
} from "../config/eslint-astro-script.js";
import { testDirectory } from "./test-directory.ts";

test.each([{ key: "status", expected: new Map([[5, 2]]) }])(
  "maps only the first declaration when define:vars lists a key twice",
  ({ key, expected }) => {
    const block = { text: `/* global\n${key}\n-- define:vars */\nstatus;` };
    const prop = { type: "Property", computed: false, key: { type: "Identifier", name: key } };
    expect(declareAstroVariables(block, { properties: [prop, prop] }, '"./vars.ts"')).toEqual(
      expected,
    );
    expect(block.text.match(/let status;/g)).toHaveLength(1);
  },
);

test.each([{ config: undefined, expected: ts.ModuleResolutionKind.Bundler }])(
  "uses bundler resolution when no project config is present",
  ({ config, expected }) => {
    expect(astroCompilerOptions(config).options.moduleResolution).toBe(expected);
  },
);

test.each([
  { virtual: "/nonexistent/entry.astro.2.ts", expected: ["/nonexistent/entry.astro.2.ts"] },
])("keeps the virtual path as the root name for inline JavaScript", ({ virtual, expected }) => {
  const scripts = new Map([[virtual, { text: "export {};", kind: ts.ScriptKind.JS }]]);
  const project = { scripts, options: { noLib: true }, folder: "/nonexistent", parsed: undefined };
  const program = compileAstroProject(project, { host: () => [] });
  expect(program.getRootFileNames()).toEqual(expected);
});

test.each([{ line: 10, expected: 10 }])(
  "keeps the original generated position for a rule other than unused variables",
  ({ line, expected }) => {
    const diagnostic = { line, column: 3, ruleId: "no-undef" };
    remapAstroVariableMessages([[diagnostic]], new Map([[0, new Map([[line, 2]])]]));
    expect(diagnostic.line).toBe(expected);
  },
);

test.each([{ name: "03_script.ts", expected: "feature.astro.3.ts" }])(
  "normalizes the numeric block prefix before creating the virtual path",
  ({ name, expected }) => {
    expect(astroBlockFile(join("feature.astro", name)).file).toBe(expected);
  },
);

test.each([{ root: "/nonexistent", expected: [] }])(
  "reuses an existing project program",
  ({ root, expected }) => {
    const parser = new AstroScriptPrograms({}, {});
    const existing = ts.createProgram({ rootNames: expected, options: { noLib: true } });
    const frontmatter = { ...parser.frontmatter, host: () => [] };
    parser.frontmatter = frontmatter;
    const project = {
      program: existing,
      folder: root,
      scripts: new Map(),
      options: { noLib: true },
    };
    expect(parser.cachedProgram(project)).toBe(existing);
  },
);

test.each([{ text: "client()", expected: "sources" }])(
  "throws for a changed virtual script without an active component",
  ({ text, expected }) => {
    const parser = new AstroScriptPrograms({}, {});
    parser.scriptProject = vi.fn(() => ({
      scripts: new Map(),
      parsed: undefined,
      options: { moduleDetection: ts.ModuleDetectionKind.Force },
      folder: "",
      program: undefined,
    }));
    expect(() => parser.parseTyped(text, { filePath: "/test/entry.astro/2_script.ts" })).toThrow(
      expected,
    );
  },
);

test.each([{ directory: "..site", expected: undefined }])(
  "excludes a tsconfig whose relative path begins with two dots",
  ({ directory, expected }) => {
    using fixture = testDirectory();
    const project = join(fixture.folder, directory);
    mkdirSync(project);
    writeFileSync(join(project, "tsconfig.json"), "{}");
    expect(findAstroTypeScriptProject(join(project, "entry.astro"), fixture.folder)).toBe(expected);
  },
);

test.each([{ name: "entry.astro", text: "<p />", expected: 0 }])(
  "avoids parsing a template when Astro's processor extracted no client blocks",
  ({ name, text, expected }) => {
    const preprocess = vi.fn(() => [text]);
    const parseTemplate = vi.fn(() => ({ result: { ast: {} }, walk: vi.fn() }));
    const parser = new AstroScriptPrograms({ preprocess }, { parseTemplate });
    parser.untyped = true;
    parser.extractScripts(text, name);
    expect(parseTemplate).toHaveBeenCalledTimes(expected);
  },
);

test.each([{ body: "\uFEFF<p />", expected: "<p />" }])(
  "strips a byte order mark from an Astro component read for project discovery",
  ({ body, expected }) => {
    using fixture = testDirectory();
    const file = join(fixture.folder, "entry.astro");
    writeFileSync(file, body);
    const preprocess = vi.fn(() => []);
    const parser = new AstroScriptPrograms({ preprocess, postprocess: vi.fn() }, {});
    parser.untyped = true;
    parser.scriptProject(file, fixture.folder);
    expect(preprocess).toHaveBeenCalledWith(expected, file);
  },
);

test.each([{ error: new Error("broken project"), expected: 1 }])(
  "adds an ESLint line to typed parser errors without a location",
  ({ error, expected }) => {
    const parser = new AstroScriptPrograms({}, {});
    parser.untyped = false;
    parser.parseTyped = () => {
      throw error;
    };
    expect(() => parser.parse("", {})).toThrow(error);
    expect(error).toMatchObject({ lineNumber: expected });
  },
);

test.each([{ component: "<p />", expected: ["<p />"] }])(
  "does not invent a frontmatter block for a component with no frontmatter",
  ({ component, expected }) => {
    const parser = new AstroScriptPrograms(
      { preprocess: () => [component] },
      { parseTemplate: () => ({ result: { ast: {} }, walk: vi.fn() }) },
    );
    parser.untyped = false;
    expect(parser.preprocess(component, "entry.astro")).toEqual(expected);
  },
);

test.each([{ name: "entry.astro", expected: 2 }])(
  "forwards all message blocks when a component has no active preprocessing entry",
  ({ name, expected }) => {
    const postprocess = vi.fn((_messages: unknown[]) => []);
    const parser = new AstroScriptPrograms({ postprocess }, {});
    parser.postprocess([[], []], name);
    expect(postprocess.mock.lastCall?.[0]).toHaveLength(expected);
  },
);
