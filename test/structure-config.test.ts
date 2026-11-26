import { join } from "node:path";
import { expect, test } from "vitest";
import skeleton from "../skeleton.json";
import {
  catalogPresetMissingMessage,
  checkStepFindings,
  findGenericFolders,
  hasCatalogPresetImport,
  hasStrykerDependency,
  hookIndexMode,
  isStrykerConfigPath,
  loadPrettier,
  mergeSkeletonEntries,
  mergeSkeletonEntry,
  mergeSkeletonList,
  missingScriptsFindings,
  missingSkeletonFileMessage,
  mutationLineRangeEntries,
  nonExecutableIndexEntries,
  normalizedBinPaths,
  ownedTemplateMatches,
  packageManifestFindings,
  prettierConfigFindings,
  reachableScriptCommands,
  runsMutationWrapper,
  testTimeoutConfigured,
  usesSharedVitest,
} from "../lib/structure-config.ts";
import type { Package } from "../lib/repo.ts";

test.each([
  {
    label: "matches exact 40-hex commit starting with short SHA",
    text: "uses: org/repo@0123456789abcdef0123456789abcdef01234567 # v1",
    template: "uses: org/repo@{{commit}} # v1",
    commit: "0123456",
    expected: true,
  },
  {
    label: "rejects non-40-hex commit",
    text: "uses: org/repo@0123456 # v1",
    template: "uses: org/repo@{{commit}} # v1",
    commit: "0123456",
    expected: false,
  },
  {
    label: "rejects mismatched commit prefix",
    text: "uses: org/repo@ffffffffffffffffffffffffffffffffffffffff # v1",
    template: "uses: org/repo@{{commit}} # v1",
    commit: "0123456",
    expected: false,
  },
  {
    label: "rejects changed surrounding text",
    text: "uses: other/repo@0123456789abcdef0123456789abcdef01234567 # v1",
    template: "uses: org/repo@{{commit}} # v1",
    commit: "0123456",
    expected: false,
  },
])("ownedTemplateMatches: $label", ({ text, template, commit, expected }) => {
  expect(ownedTemplateMatches(text, template, commit)).toBe(expected);
});

test.each([
  {
    label: "replaces older item with same matcher and preserves repo items",
    has: [
      { matcher: "Bash", hooks: ["old"] },
      { matcher: "Write", hooks: ["custom"] },
    ],
    wanted: [{ matcher: "Bash", hooks: ["new"] }],
    expected: [
      { matcher: "Bash", hooks: ["new"] },
      { matcher: "Write", hooks: ["custom"] },
    ],
  },
  {
    label: "replaces non-array existing value",
    has: "invalid",
    wanted: ["a", "b"],
    expected: ["a", "b"],
  },
])("mergeSkeletonList: $label", ({ has, wanted, expected }) => {
  expect(mergeSkeletonList(has, wanted)).toEqual(expected);
});

test.each([
  {
    label: "returns ok when scalar matches",
    file: { nested: { flag: true } },
    template: { nested: { flag: true } },
    key: ["nested", "flag"],
    expectedStatus: "ok",
    expectedFile: { nested: { flag: true } },
  },
  {
    label: "creates missing parent objects and updates value",
    file: {},
    template: { nested: { flag: true } },
    key: ["nested", "flag"],
    expectedStatus: "updated",
    expectedFile: { nested: { flag: true } },
  },
  {
    label: "returns invalid-parent when parent is a primitive",
    file: { nested: "not-an-object" },
    template: { nested: { flag: true } },
    key: ["nested", "flag"],
    expectedStatus: "invalid-parent",
    expectedFile: { nested: "not-an-object" },
  },
])("mergeSkeletonEntry: $label", ({ file, template, key, expectedStatus, expectedFile }) => {
  expect(mergeSkeletonEntry(file, template, key)).toBe(expectedStatus);
  expect(file).toEqual(expectedFile);
});

test("mergeSkeletonEntries separates invalidParents from differ in key order", () => {
  const file = { bad: 1, good: { value: "old" } };
  const template = { bad: { leaf: 2 }, good: { value: "new" }, same: { ok: true } };
  const result = mergeSkeletonEntries(file, template, [
    ["bad", "leaf"],
    ["good", "value"],
    ["same", "ok"],
  ]);
  expect(result).toEqual({ invalidParents: ["bad.leaf"], differ: ["good.value", "same.ok"] });
});

test.each([
  {
    label: "direct default re-export",
    config: 'export { default } from "@hackersandwizards/scaffolding/vitest";',
    expected: true,
  },
  {
    label: "mergeConfig with imported base",
    config:
      'import base from "@hackersandwizards/scaffolding/vitest";\nexport default mergeConfig(base, { test: {} });',
    expected: true,
  },
  {
    label: "syntax error fails closed",
    config: 'export { default } from "@hackersandwizards/scaffolding/vitest"; {{{',
    expected: false,
  },
  {
    label: "imported base unused in export default",
    config:
      'import base from "@hackersandwizards/scaffolding/vitest";\nexport default mergeConfig(other, {});',
    expected: false,
  },
])("usesSharedVitest: $label", ({ config, expected }) => {
  expect(usesSharedVitest(config)).toBe(expected);
});

test.each([
  { script: "scaffolding-mutation", ownBin: undefined, expected: true },
  { script: "FOO='a b' bun --no-env-file scaffolding-mutation", ownBin: undefined, expected: true },
  {
    script: "bun --no-env-file bin/scaffolding-mutation.ts",
    ownBin: "bin/scaffolding-mutation.ts",
    expected: true,
  },
  { script: "stryker run", ownBin: undefined, expected: false },
  { script: 42, ownBin: undefined, expected: false },
])("runsMutationWrapper($script, $ownBin) is $expected", ({ script, ownBin, expected }) => {
  expect(runsMutationWrapper(script, ownBin)).toBe(expected);
});

test.each([
  {
    path: "stryker.config.mjs",
    text: 'export default { mutate: ["lib/a.ts", "lib/b.ts:10-20", "lib/c.ts:1:2-3:4"] };',
    expected: ["lib/b.ts:10-20", "lib/c.ts:1:2-3:4"],
  },
  {
    path: "stryker.conf.json",
    text: '{"mutate": ["src/a.ts:5-9", "src/b.ts"]}',
    expected: ["src/a.ts:5-9"],
  },
])("mutationLineRangeEntries parses $path", async ({ path, text, expected }) => {
  expect(await mutationLineRangeEntries(path, text)).toEqual(expected);
});

test.each<{
  label: string;
  entry: string;
  scripts: Record<string, string>;
  expected: string[];
}>([
  {
    label: "follows nested bun run chains without looping",
    entry: "test",
    scripts: {
      test: "bun run --silent test:unit",
      "test:unit": "bun run test && vitest run",
    },
    expected: ["test", "bun run --silent test:unit", "bun run test && vitest run"],
  },
  {
    label: "keeps literal command when not a script name",
    entry: "bun test",
    scripts: { test: "vitest run" },
    expected: ["bun test"],
  },
])("reachableScriptCommands: $label", ({ entry, scripts, expected }) => {
  expect(reachableScriptCommands(entry, scripts)).toEqual(expected);
});

test.each([
  { pkg: { devDependencies: { "@stryker-mutator/core": "10.0.0" } }, expected: true },
  { pkg: { dependencies: { vitest: "5.0.0" } }, expected: false },
])("hasStrykerDependency classifies %j", ({ pkg, expected }) => {
  expect(hasStrykerDependency(pkg as Package)).toBe(expected);
});

test("packageManifestFindings reports type, engines, packageManager, and missing scripts in order", () => {
  const pkg: Package = {
    type: "commonjs",
    engines: { npm: "npm" },
    packageManager: "bun@1.0.0",
    scripts: {},
    scaffolding: { skip: { catalog: "no catalog" } },
  };
  const hits = packageManifestFindings(pkg, {
    ...skeleton.package,
    packageManager: "bun@1.4.5",
    catalogScripts: skeleton.catalog.scripts,
  });
  expect(hits[0]?.message).toContain("type must be module");
  expect(hits[1]?.message).toContain("engines.npm must be please-use-bun");
  expect(hits[2]?.message).toContain("packageManager must be bun@1.4.5");
  expect(hits[3]?.message).toContain("script check missing");
});

test.each([
  {
    label: "accepts placed step and valid check:* script",
    pkg: {
      scripts: { "check:custom": "echo ok" },
      scaffolding: { check: ["links", "check:custom"] },
    } as Package,
    expectedTexts: [],
  },
  {
    label: "rejects unprefixed step and missing check:* script",
    pkg: {
      scripts: {},
      scaffolding: { check: ["lint-docs", ["check:missing"]] },
    } as Package,
    expectedTexts: ["lint-docs", "check:missing"],
  },
])("checkStepFindings: $label", ({ pkg, expectedTexts }) => {
  expect(checkStepFindings(pkg).map((h) => h.text)).toEqual(expectedTexts);
});

test.each([
  { pkg: { bin: "./bin/cli.ts" } as Package, expected: ["bin/cli.ts"] },
  {
    pkg: { bin: { a: "./bin/a.ts", b: "bin/a.ts", c: "./bin/c.ts" } } as Package,
    expected: ["bin/a.ts", "bin/c.ts"],
  },
  { pkg: {} as Package, expected: [] },
])("normalizedBinPaths normalizes and deduplicates %j", ({ pkg, expected }) => {
  expect(normalizedBinPaths(pkg)).toEqual(expected);
});

test.each([
  {
    paths: ["src/utils/a.ts", "a/Core/b.ts", "lib/helpers/nested/c.ts", "lib/repo.ts"],
    expected: ["a/Core", "lib/helpers", "src/utils"],
  },
  { paths: ["bin/check-names.ts", "lib/help.ts"], expected: [] },
])("findGenericFolders finds generic directories in %j", ({ paths, expected }) => {
  expect(findGenericFolders(paths)).toEqual(expected);
});

test.each([
  {
    label: "accepts script referencing SCAFFOLDING_TEST_TIMEOUT_MS",
    entry: "test",
    scripts: { test: "bun test --timeout ${SCAFFOLDING_TEST_TIMEOUT_MS:-5000}" },
    configTexts: [],
    expected: true,
  },
  {
    label: "accepts shared vitest config",
    entry: "test",
    scripts: { test: "vitest run" },
    configTexts: ['export { default } from "@hackersandwizards/scaffolding/vitest";'],
    expected: true,
  },
  {
    label: "rejects unconfigured test runner",
    entry: "test",
    scripts: { test: "vitest run" },
    configTexts: ["export default {};"],
    expected: false,
  },
])("testTimeoutConfigured: $label", ({ entry, scripts, configTexts, expected }) => {
  expect(testTimeoutConfigured(entry, scripts, configTexts)).toBe(expected);
});

test("loadPrettier resolves prettier from the repository checkout", async () => {
  const prettier = await loadPrettier(join(import.meta.dirname, ".."));
  expect(typeof prettier?.resolveConfig).toBe("function");
  expect(typeof prettier?.format).toBe("function");
});

test.each([
  { rc: { printWidth: 100, semi: true }, expectedTexts: [] },
  { rc: { printWidth: 80, semi: true }, expectedTexts: ["printWidth: 80"] },
])("prettierConfigFindings checks %j", ({ rc, expectedTexts }) => {
  expect(prettierConfigFindings(rc, { printWidth: 100, semi: true }).map((h) => h.text)).toEqual(
    expectedTexts,
  );
});

test.each([
  {
    label: "requires catalog build script when catalog is not skipped",
    pkg: {
      scripts: { check: "scaffolding check" },
    } as Package,
    expectedTexts: ["build"],
  },
  {
    label: "skips catalog build script when scaffolding.skip.catalog has a reason",
    pkg: {
      scripts: { check: "scaffolding check" },
      scaffolding: { skip: { catalog: "library only" } },
    } as Package,
    expectedTexts: [],
  },
])("missingScriptsFindings: $label", ({ pkg, expectedTexts }) => {
  expect(missingScriptsFindings(pkg, ["check"], ["build"]).map((h) => h.text)).toEqual(
    expectedTexts,
  );
});

test.each([
  { path: "LICENSE", expectedFragment: "scaffolding.private: true" },
  { path: "README.md", expectedFragment: "missing: create this required skeleton file" },
])("missingSkeletonFileMessage formats guidance for $path", ({ path, expectedFragment }) => {
  expect(missingSkeletonFileMessage(path)).toContain(expectedFragment);
});

test.each([
  { path: "stryker.config.mjs", expected: true },
  { path: "sub/.stryker.conf.json", expected: true },
  { path: "stryker.ts", expected: false },
])("isStrykerConfigPath classifies $path", ({ path, expected }) => {
  expect(isStrykerConfigPath(path)).toBe(expected);
});

test.each([
  {
    label: "selects stage-0 100644 entries and skips executable or unmerged ones",
    output: ["100644 abc 0\tbin/a.ts", "100755 def 0\tbin/b.ts", "100644 ghi 2\tbin/c.ts", ""].join(
      "\0",
    ),
    expected: [{ mode: "100644", blob: "abc", path: "bin/a.ts" }],
  },
  { label: "handles empty output", output: "", expected: [] },
])("nonExecutableIndexEntries: $label", ({ output, expected }) => {
  expect(nonExecutableIndexEntries(output)).toEqual(expected);
});

test.each([
  {
    output: "100644 deadbeef 0\t.githooks/pre-commit\n",
    expected: { mode: "100644", blob: "deadbeef" },
  },
  { output: "", expected: { mode: undefined, blob: undefined } },
])("hookIndexMode parses $output", ({ output, expected }) => {
  expect(hookIndexMode(output)).toEqual(expected);
});

test.each([
  {
    texts: ['import { catalog } from "@hackersandwizards/scaffolding/catalog";'],
    preset: "@hackersandwizards/scaffolding/catalog",
    expected: true,
  },
  {
    texts: ['import other from "other/catalog";'],
    preset: "@hackersandwizards/scaffolding/catalog",
    expected: false,
  },
])("hasCatalogPresetImport checks $expected", ({ texts, preset, expected }) => {
  expect(hasCatalogPresetImport(texts, preset)).toBe(expected);
});

test("catalogPresetMissingMessage names the preset and skip escape hatch", () => {
  expect(catalogPresetMissingMessage("@pkg/catalog")).toContain('from "@pkg/catalog"');
});
