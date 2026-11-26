import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as compiler from "@astrojs/compiler-rs";
import { expect, test, vi } from "vitest";
import {
  astroFrontmatterCode,
  AstroModuleMirror,
  checkAstroImports,
  prepareCyclesCache,
} from "../lib/astro-imports.ts";
import { testDirectory } from "./test-directory.ts";

test.each([["012345", { frontmatter: { program: { start: 1.8, end: 4.3 } } }, "123"]])(
  "preserves slice coercion for compiler positions",
  (input, ast, expected) => {
    expect(astroFrontmatterCode(input, ast)).toBe(expected);
  },
);

test.each([["node_modules", undefined]])(
  "stops before creating cache directories through a symlink",
  (relative, expected) => {
    using temp = testDirectory();
    using target = testDirectory();
    symlinkSync(target.folder, join(temp.folder, relative), "dir");
    expect(prepareCyclesCache(temp.folder)).toBe(expected);
    expect(existsSync(join(target.folder, ".cache"))).toBe(false);
  },
);

test.each([[["tsconfig.extra.json", "ignored.css"], "tsconfig.extra.json"]])(
  "copies matching configuration files into the mirror",
  (files, expected) => {
    using temp = testDirectory();
    using mirror = testDirectory();
    for (const path of files) writeFileSync(join(temp.folder, path), "fixture");
    new AstroModuleMirror(temp.folder, mirror.folder, compiler).copySources(files);
    expect(readFileSync(join(mirror.folder, expected), "utf8")).toBe("fixture");
    expect(existsSync(join(mirror.folder, "ignored.css"))).toBe(false);
  },
);

test.each([["parts/page.astro.script-4.ts", "parts/page.astro"]])(
  "records generated names against their component paths",
  (module, source) => {
    using temp = testDirectory();
    using directory = testDirectory();
    const mirror = new AstroModuleMirror(temp.folder, directory.folder, compiler);
    expect(mirror.writeModule(module, source, "export {}")).toBeUndefined();
    expect(mirror.originals.get(module)).toBe(source);
    expect(readFileSync(join(directory.folder, module), "utf8")).toBe("export {}");
  },
);

test.each([["page.astro", ["page.astro.ts", "parse", "page.astro.script-1.ts"]]])(
  "writes the server before parsing and skips empty scripts",
  (path, expected) => {
    using temp = testDirectory();
    using directory = testDirectory();
    writeFileSync(join(temp.folder, path), "const value = 1;");
    const calls: string[] = [];
    const parse: typeof compiler.parse = (text) => {
      calls.push("parse");
      return {
        ast: { frontmatter: { program: { start: 0, end: text.length } } },
        diagnostics: [],
      };
    };
    const transform = () =>
      ({
        code: 'import "page.astro?astro&type=script";\nconst server = 1;',
        scripts: [{ code: "" }, { code: "client();" }],
        diagnostics: [],
      }) as unknown as ReturnType<typeof compiler.transform>;
    const mirror = new AstroModuleMirror(temp.folder, directory.folder, { parse, transform });
    vi.spyOn(mirror, "writeModule").mockImplementation((module) => {
      calls.push(module);
      return undefined;
    });
    expect(mirror.compileComponent(path, true)).toEqual([]);
    expect(calls).toEqual(expected);
    expect(mirror.writeModule).toHaveBeenNthCalledWith(
      1,
      "page.astro.ts",
      path,
      "const server = 1;",
    );
  },
);

test.each([["node_modules", "the cycles cache path contains a symlink"]])(
  "does not visit source modules when the Astro mirror root is unsafe",
  async (relative, expected) => {
    using temp = testDirectory();
    mkdirSync(join(temp.folder, "link-target"));
    symlinkSync(join(temp.folder, "link-target"), join(temp.folder, relative), "dir");
    const visit = vi.fn();
    const message = await checkAstroImports(temp.folder, ["component.astro"], visit).then(
      ({ findings }) => findings[0]?.message,
      () => undefined,
    );
    expect(message).toContain(expected);
    expect(visit).not.toHaveBeenCalled();
  },
);
