import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ICruiseResult, IDependency } from "dependency-cruiser";
import { expect, test, vi } from "vitest";
import {
  checkImports,
  cruiseImportFiles,
  ImportOrigin,
  inspectCruisedModules,
  runtimeCycleFindings,
} from "../lib/import-scan.ts";
import { testDirectory } from "./test-directory.ts";

test.each([["./entry.css?raw#id", "entry.css"]])(
  "resolves queried assets from the source checkout",
  (specifier, expected) => {
    using temp = testDirectory();
    writeFileSync(join(temp.folder, expected), "body{}");
    const origin = new ImportOrigin(temp.folder, {
      directory: join(temp.folder, "mirror"),
      originals: new Map(),
    });
    const dependency = { module: specifier, resolved: "../entry.css" } as IDependency;
    expect(origin.dependencyTarget(dependency, "index.astro")).toBe(join(temp.folder, expected));
  },
);

test.each([["node_modules/removed/index.js", {}]])(
  "ignores installed imports before touching the target",
  (resolved, expected) => {
    using temp = testDirectory();
    const dependency = { module: "removed", resolved } as IDependency;
    expect(new ImportOrigin(temp.folder).inspect(dependency, "source.ts")).toEqual(expected);
  },
);

test.each([["entry.ts", ["entry.ts", "target.ts"]]])(
  "cruises an entry with a path alias read from tsconfig",
  async (entry, expected) => {
    using temp = testDirectory();
    writeFileSync(
      join(temp.folder, "tsconfig.json"),
      '{"compilerOptions":{"paths":{"@target":["./target.ts"]}}}',
    );
    writeFileSync(join(temp.folder, entry), 'import "@target";');
    writeFileSync(join(temp.folder, "target.ts"), "export const target = true;");
    const result = await cruiseImportFiles(new ImportOrigin(temp.folder), [entry]);
    expect(result.output).toHaveProperty("modules");
    const output = result.output as ICruiseResult;
    expect(output.modules.map(({ source }) => source)).toEqual(expected);
  },
);

test.each([
  [["page.astro.ts", "page.astro.script-2.ts"], ["page.astro -> page.astro -> page.astro"]],
])(
  "deduplicates cycles on original cruiser identities before translating paths",
  ([server, script], expected) => {
    const violations = [server, script].map((from) => ({
      from: from,
      to: script,
      rule: { name: "cycles", severity: "error" as const },
      cycle: [
        { name: server, dependencyTypes: [] },
        { name: script, dependencyTypes: [] },
      ],
    }));
    const originals = new Map([
      [server, "page.astro"],
      [script, "page.astro"],
    ]);
    const origin = new ImportOrigin("/checkout", { directory: "/mirror", originals });
    expect(runtimeCycleFindings(violations, origin).map(({ text }) => text)).toEqual(expected);
  },
);

test.each([
  [
    ["relative.ts", "other.ts"],
    ["./missing-first.ts", "./missing-second.ts"],
  ],
])(
  "reports unresolved dependencies in module and source order while visiting resolved imports",
  ([source, second], expected) => {
    using temp = testDirectory();
    writeFileSync(join(temp.folder, "present.ts"), "export const value = true;");
    const firstDependency = {
      module: "./missing-first.ts",
      resolved: "./missing-first.ts",
      couldNotResolve: true,
    } as IDependency;
    const secondDependency = {
      module: "./missing-second.ts",
      resolved: "./missing-second.ts",
      couldNotResolve: true,
    } as IDependency;
    const present = {
      module: "./present.ts",
      resolved: "present.ts",
      moduleSystem: "es6",
    } as IDependency;
    const visit = vi.fn();
    const findings = inspectCruisedModules(
      [
        { source: source, dependencies: [firstDependency, present] },
        { source: second, dependencies: [secondDependency] },
      ],
      new ImportOrigin(temp.folder),
      visit,
    );
    expect(findings.map(({ text }) => text)).toEqual(expected);
    expect(visit).toHaveBeenCalledExactlyOnceWith({
      source,
      file: join(temp.folder, source),
      imports: [{ target: "present.ts", specifier: "./present.ts", system: "es6" }],
    });
  },
);

test.each([["empty.ts", ["complete", "findings", "hasRuntimeCycle"]]])(
  "keeps graph result field order when a file has no imports",
  async (entry, expected) => {
    using temp = testDirectory();
    writeFileSync(join(temp.folder, entry), "export {};");
    expect(Object.keys(await checkImports(new ImportOrigin(temp.folder), [entry]))).toEqual(
      expected,
    );
  },
);

test.each([[{ module: "./missing.astro", couldNotResolve: true } as IDependency, TypeError]])(
  "throws for a mirrored dependency whose resolved field is absent",
  (dependency, expected) => {
    const origin = new ImportOrigin("/checkout", { directory: "/mirror", originals: new Map() });
    expect(() => origin.dependencyTarget(dependency, "index.astro")).toThrow(expected);
  },
);

test.each([["constructor", "constructor"]])(
  "returns an unmapped source name verbatim",
  (path, expected) => {
    const origin = new ImportOrigin("/checkout", { directory: "/mirror", originals: new Map() });
    expect(origin.originalPath(path)).toBe(expected);
  },
);
