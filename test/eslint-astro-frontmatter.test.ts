import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test, vi } from "vitest";
import {
  astroSnapshot,
  createAstroLanguage,
  installAstroSourceFiles,
  resolveAstroPackage,
} from "../config/eslint-astro-frontmatter.js";
import { testDirectory } from "./test-directory.ts";

test.each([{ directory: "node_modules/astro", expected: "package.json" }])(
  "resolves the consumer's Astro before the bundled Astro",
  ({ directory, expected }) => {
    using fixture = testDirectory();
    const packageDir = join(fixture.folder, directory);
    mkdirSync(packageDir, { recursive: true });
    const packageFile = join(packageDir, expected);
    writeFileSync(packageFile, '{"name":"astro","exports":{"./package.json":"./package.json"}}');
    expect(resolveAstroPackage(fixture.folder)).toBe(packageFile);
  },
);

test.each([{ file: "entry.astro", source: "", expected: "export {};" }])(
  "registers virtual code even for an empty Astro document",
  ({ file, source, expected }) => {
    const readFile = vi.fn(() => source);
    const language = createAstroLanguage({ readFile }, () => ({ code: expected }));
    const snapshot = language.scripts.get(file)?.generated?.root.snapshot;
    expect(snapshot?.getText(0, expected.length)).toBe(expected);
  },
);

test.each([{ file: "entry.astro", source: "export const tag = <p />;", expected: [] }])(
  "parses virtual Astro source as TSX",
  ({ file, source, expected }) => {
    const host = {
      getSourceFile: vi.fn<(file: string, version: ts.ScriptTarget) => ts.SourceFile>(),
      getScriptSnapshot: () => ts.ScriptSnapshot.fromString(source),
    };
    installAstroSourceFiles(host);
    expect(host.getSourceFile(file, ts.ScriptTarget.ESNext)).toMatchObject({
      parseDiagnostics: expected,
    });
  },
);

test.each([{ source: undefined, expected: undefined }])(
  "leaves an unreadable Astro source without a snapshot",
  ({ source, expected }) => {
    expect(astroSnapshot(source)).toBe(expected);
  },
);
