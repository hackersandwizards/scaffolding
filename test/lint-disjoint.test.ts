import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { expect, test, vi } from "vitest";
import {
  AstroRuleFiles,
  astroSharedEslintRules,
  readAstroLintRegions,
} from "../lib/lint-disjoint.ts";
import { labelLintOverlaps } from "../lib/lint-rule-overlaps.ts";
import { testDirectory } from "./test-directory.ts";

test.each([
  [
    { check: "structure", path: "a.astro", text: "previous", message: "example", prefix: "lint" },
    "Astro client script",
  ],
])("labels rule overlaps without moving serialized fields", (finding, region) => {
  expect(JSON.stringify(labelLintOverlaps([finding], region))).toBe(
    '[{"check":"structure","path":"a.astro","text":"Astro client script","message":"example","prefix":"lint"}]',
  );
});

test.each([["\uFEFFExample", ["preprocess", "regions", "postprocess"]]])(
  "reads processor regions before cleaning up its state",
  (source, expected) => {
    using directory = testDirectory();
    const file = join(directory.folder, "a.astro");
    writeFileSync(file, source);
    const calls: string[] = [];
    const preprocess = vi.fn(() => {
      calls.push("preprocess");
      return ["virtual"];
    });
    const oxlintRegions = vi.fn(() => {
      calls.push("regions");
      return { ranges: [], scripts: new Set<number>() };
    });
    const postprocess = vi.fn(() => {
      calls.push("postprocess");
      return [];
    });
    readAstroLintRegions(file, { preprocess, oxlintRegions, postprocess });
    expect(calls).toEqual(expected);
    expect(preprocess).toHaveBeenCalledWith("Example", file);
    expect(postprocess).toHaveBeenCalledWith([[]], file);
  },
);

test.each([[{ alpha: "error", constructor: "warn" }, { constructor: "warn" }]])(
  "retains a rule named constructor in the matching region",
  (rules, expected) => {
    expect(
      astroSharedEslintRules({
        rules,
        processor: { reportsInOxlintRegion: (rule) => rule === "constructor" },
      }),
    ).toEqual(expected);
  },
);

test.each([["a.astro", ["Astro frontmatter", "Astro client script"]]])(
  "checks the frontmatter before the eligible client script",
  async (file, expected) => {
    using directory = testDirectory();
    writeFileSync(join(directory.folder, file), "example");
    const eslint = new ESLint({ overrideConfigFile: true });
    vi.spyOn(eslint, "calculateConfigForFile").mockResolvedValue({
      rules: { "no-debugger": "error" },
    });
    const processor = {
      preprocess: () => [
        "content",
        { text: "", filename: "front.ts" },
        { text: "", filename: "omit.ts" },
        { text: "", filename: "client.js" },
      ],
      frontmatterBlock: "front.ts",
      oxlintRegions: () => ({ ranges: [], scripts: new Set([3]) }),
    };
    const findings = await new AstroRuleFiles(directory.folder, eslint).overlaps(
      file,
      { processor },
      new Set(["no-debugger"]),
    );
    expect(findings.map(({ text }) => text)).toEqual(expected);
    expect(eslint.calculateConfigForFile).toHaveBeenNthCalledWith(1, join(file, "1_front.ts"));
    expect(eslint.calculateConfigForFile).toHaveBeenNthCalledWith(2, join(file, "3_client.js"));
  },
);

test.each([["demo.astro/8_missing.ts", []]])(
  "returns no overlap for a virtual file without ESLint config",
  async (path, expected) => {
    const eslint = new ESLint({ overrideConfigFile: true });
    vi.spyOn(eslint, "calculateConfigForFile").mockResolvedValue(undefined);
    const files = new AstroRuleFiles("/checkout", eslint);
    const findings = await files
      .virtualFileOverlaps(path, new Set(["no-debugger"]), "Astro frontmatter")
      .catch((error: unknown) => ({ error }));
    expect(findings).toEqual(expected);
  },
);
