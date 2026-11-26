import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  CatalogCopies,
  catalogAssetMime,
  catalogCopyPrefixes,
  catalogPackageOf,
  readCatalogPackage,
} from "../catalog/copy-assets.ts";
import { testDirectory } from "./test-directory.ts";

test.each([{ input: "asset.PDF", expected: "application/pdf" }])(
  "serves case-insensitive PDF suffixes",
  ({ input, expected }) => expect(catalogAssetMime(input)).toBe(expected),
);

test.each([{ input: "@scope/pkg/assets/a", expected: "@scope/pkg" }])(
  "takes both segments of a scoped package name",
  ({ input, expected }) => expect(catalogPackageOf(input)).toBe(expected),
);

test.each([{ patterns: ["assets/a[12].svg"], expected: [["assets/a[12].svg", "assets"]] }])(
  "stops a copy prefix before a bracket glob",
  ({ patterns, expected }) => expect(catalogCopyPrefixes(patterns)).toEqual(expected),
);

test.each([
  {
    input: { name: "@scope/sample", optionalDependencies: { fallback: "1" } },
    expected: "fallback",
  },
])("includes optional dependencies in copy resolution", ({ input, expected }) => {
  using fixture = testDirectory();
  const { folder } = fixture;
  writeFileSync(join(folder, "package.json"), JSON.stringify(input));
  expect(readCatalogPackage(folder).declared).toContain(expected);
});

test.each([
  {
    entry: "thing/hidden.txt",
    expected: "catalog copy: thing/hidden.txt is no file in the exports of thing",
  },
])("reports the package whose export is missing", ({ entry, expected }) => {
  using fixture = testDirectory();
  const { folder } = fixture;
  writeFileSync(join(folder, "package.json"), '{"name":"thing","exports":{".":"./index.js"}}');
  expect(() => new CatalogCopies().resolve([entry], readCatalogPackage(folder))).toThrow(expected);
});

test.each([{ pattern: "*.txt", first: "one.txt", later: "two.txt", expected: ["one.txt"] }])(
  "keeps the cached glob until a fresh copy is requested",
  ({ pattern, first, later, expected }) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    const copies = new CatalogCopies();
    copies.resolve([], readCatalogPackage(folder));
    writeFileSync(join(folder, first), "");
    copies.copied(pattern);
    writeFileSync(join(folder, later), "");
    expect(copies.copied(pattern).map(([name]) => name)).toEqual(expected);
  },
);

test.each([{ pattern: "assets/*", file: "assets/dir/item.txt", expected: undefined }])(
  "refuses a request with parent path segments even if it resolves inside a match",
  ({ pattern, file, expected }) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    const copies = new CatalogCopies();
    copies.resolve([], readCatalogPackage(folder));
    mkdirSync(join(folder, "assets/dir"), { recursive: true });
    writeFileSync(join(folder, file), "");
    expect(copies.servePath("assets/dir/../dir/item.txt", catalogCopyPrefixes([pattern]))).toBe(
      expected,
    );
  },
);

test.each([{ patterns: ["one.txt", "absent.txt"], expected: "written first" }])(
  "copies earlier matches before failing on a later missing pattern",
  ({ patterns, expected }) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    const copies = new CatalogCopies();
    copies.resolve([], readCatalogPackage(folder));
    writeFileSync(join(folder, "one.txt"), expected);
    const out = join(folder, "out");
    mkdirSync(out);
    expect(() => copies.build(out, patterns)).toThrow("absent.txt matches nothing");
    expect(existsSync(join(out, "one.txt"))).toBe(true);
    expect(readFileSync(join(out, "one.txt"), "utf8")).toBe(expected);
  },
);
