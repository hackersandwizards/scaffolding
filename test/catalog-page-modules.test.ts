import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readCatalogPackage } from "../catalog/copy-assets.ts";
import { CatalogMount } from "../catalog/mount.ts";
import {
  CatalogPageModules,
  catalogAdminUrl,
  catalogBrandStyles,
  catalogPageNav,
  catalogStorySlash,
  checkCatalogBrandVersion,
  validateCatalogHeader,
} from "../catalog/page-modules.ts";
import { catalogRequire, catalogSetupEvent, sampleCatalog } from "./catalog-fixtures.ts";
import { testDirectory } from "./test-directory.ts";

test.each([{ version: "2.9.99", expected: "installed is v2.9.99" }])(
  "does not count a brand patch release toward the minimum minor version",
  ({ version, expected }) => {
    using fixture = testDirectory();
    const modules = join(fixture.folder, "node_modules");
    const installed = join(modules, "@hackersandwizards/brand");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "package.json"), JSON.stringify({ version }));
    expect(() => checkCatalogBrandVersion(fixture.folder)).toThrow(expected);
  },
);

test.each([{ homeCss: ["./a.css", "./b.css", "./a.css"], expected: ["./a.css", "./b.css"] }])(
  "deduplicates a home stylesheet list while retaining its first occurrence",
  ({ homeCss, expected }) => {
    using fixture = testDirectory();
    const result = catalogBrandStyles(
      { ...sampleCatalog, homeCss },
      catalogRequire(),
      fixture.folder,
    );
    expect(result.lists.home).toEqual(expected);
  },
);

test.each([
  {
    htmlClass: ["some class"],
    nav: { current: "absent", items: [] },
    expected: "catalog htmlClass",
  },
])(
  "reports invalid HTML classes before an invalid nav selection",
  ({ htmlClass, nav, expected }) => {
    expect(() => validateCatalogHeader(htmlClass, nav)).toThrow(expected);
  },
);

test.each([{ href: "//external/path", expected: [{ name: "Other", href: "//external/path" }] }])(
  "preserves a scheme-relative nav link under a catalog base",
  ({ href, expected }) => {
    const nav = { items: [{ name: "Other", href }] };
    expect(catalogPageNav(nav, { base: "/site", link: "/site/catalog/" })).toEqual(expected);
  },
);

test.each([{ base: "/site", expected: "" }])(
  "uses unsuffixed links when trailingSlash is never even with directory output",
  ({ base, expected }) => {
    using fixture = testDirectory();
    const { config } = catalogSetupEvent(fixture.folder, base);
    config.trailingSlash = "never";
    expect(catalogStorySlash(config)).toBe(expected);
  },
);

test.each([
  {
    name: "sample / other",
    expected: "http://admin.localhost:4329/sample%20%2F%20other/dashboard",
  },
])("escapes an explicit admin name as one path segment", ({ name, expected }) => {
  using fixture = testDirectory();
  writeFileSync(join(fixture.folder, "package.json"), JSON.stringify({ admin: { name } }));
  expect(
    catalogAdminUrl(true, { ...sampleCatalog, admin: true }, readCatalogPackage(fixture.folder)),
  ).toBe(expected);
});

test.each([
  {
    base: "/site",
    expected: [
      "product",
      "href",
      "nav",
      "link",
      "title",
      "lead",
      "previews",
      "previewSize",
      "themeToggle",
      "headerToggle",
      "onDisk",
      "storyScale",
      "htmlClass",
      "groupOrder",
      "previewStates",
      "provenance",
      "layers",
      "slash",
      "admin",
    ],
  },
])("creates runtime fields in their original order", ({ base, expected }) => {
  using fixture = testDirectory();
  const mount = new CatalogMount().configureMount(catalogSetupEvent(fixture.folder, base));
  const require = catalogRequire();
  const project = { ...readCatalogPackage(fixture.folder), require };
  const pages = new CatalogPageModules(sampleCatalog, mount, project);
  expect(
    Object.keys(
      pages.runtime(
        "sample",
        catalogBrandStyles(sampleCatalog, require, fixture.folder),
        undefined,
      ),
    ),
  ).toEqual(expected);
});

test.each([{ homeCss: ["./first.css"], expected: "first.css" }])(
  "retains a distinct home stylesheet in the generated CSS virtual module",
  ({ homeCss, expected }) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    const mount = new CatalogMount().configureMount(catalogSetupEvent(folder, "/site"));
    const project = { ...readCatalogPackage(folder), require: catalogRequire() };
    const pages = new CatalogPageModules({ ...sampleCatalog, homeCss }, mount, project);
    expect(
      pages.sources(join(folder, "stories")).modules["virtual:scaffolding/catalog-css/home"],
    ).toBe(`import ${JSON.stringify(join(folder, expected))};`);
  },
);
