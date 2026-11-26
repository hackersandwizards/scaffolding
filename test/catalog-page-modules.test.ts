import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, vi } from "vitest";
import { defined } from "../lib/defined.ts";
import { jsonObject } from "../lib/json.ts";
import { readCatalogPackage } from "../catalog/copy-assets.ts";
import { CatalogMount } from "../catalog/mount.ts";
import {
  CatalogFocusRing,
  CatalogPageModules,
  catalogAroundStylesheets,
  catalogBrandLayers,
  catalogBrandTokens,
  catalogAdminUrl,
  catalogModuleSpecifier,
  catalogStylesheetLists,
  catalogStylesheetModules,
  catalogStylesheetVersions,
  catalogToggleComponent,
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
    expect(catalogStylesheetLists({ ...sampleCatalog, homeCss }, []).home).toEqual(expected);
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
])("serializes runtime fields in their original order", ({ base, expected }) => {
  using fixture = testDirectory();
  const { folder } = fixture;
  writeFileSync(join(folder, "package.json"), '{"admin":{"name":"sample"}}');
  const mount = new CatalogMount();
  const event = catalogSetupEvent(folder, base);
  event.command = "dev";
  const params = mount.configureMount(event);
  const project = { ...readCatalogPackage(folder), require: catalogRequire() };
  const options = {
    ...sampleCatalog,
    nav: { items: [] },
    previewSize: [800, 600] satisfies [number, number],
    storyScale: "screen",
    admin: true,
  };
  const pages = new CatalogPageModules(options, mount, project);
  const source = defined(
    pages.sources(params).modules["virtual:scaffolding/catalog"],
    "catalog virtual module",
  );
  expect(Object.keys(jsonObject(source.slice("export default ".length, -1)))).toEqual(expected);
});

test.each([{ homeCss: ["./first.css"], expected: "first.css" }])(
  "retains a distinct home stylesheet in the generated CSS virtual module",
  ({ homeCss, expected }) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    const mount = new CatalogMount();
    const params = mount.configureMount(catalogSetupEvent(folder, "/site"));
    const project = { ...readCatalogPackage(folder), require: catalogRequire() };
    const pages = new CatalogPageModules({ ...sampleCatalog, homeCss }, mount, project);
    expect(pages.sources(params).modules["virtual:scaffolding/catalog-css/home"]).toBe(
      `import ${JSON.stringify(join(folder, expected))};`,
    );
  },
);

test.each([{ input: ["custom"], expected: [] }])(
  "omits the installed focus stylesheet when explicit classes exclude the ring",
  ({ input, expected }) => {
    const require = catalogRequire();
    vi.mocked(require.resolve).mockReturnValue("/fixture/focus.css");
    expect(new CatalogFocusRing({ htmlClass: input }, require).stylesheets).toEqual(expected);
  },
);

test.each([{ enabled: false, expected: false }])(
  "skips resolving the toggle component when the theme option is disabled",
  ({ enabled, expected }) => {
    const require = catalogRequire();
    vi.mocked(require.resolve).mockReturnValue("/fixture/ThemeToggle.astro");
    expect(catalogToggleComponent(enabled, require)).toBe(expected);
    expect(require.resolve).not.toHaveBeenCalled();
  },
);

test.each([
  {
    css: ["./alpha.css", "./beta.css"],
    expected: ["ground.css", "alpha.css", "beta.css", "chrome.css"],
  },
])("places header styles between the ground and chrome styles", ({ css, expected }) => {
  const paths = catalogAroundStylesheets({ component: "./Header.astro", css });
  expect(paths.map((path) => basename(path))).toEqual(expected);
});

test.each([
  {
    lists: {
      home: ["./local.css", "@example/a.css"],
      dashboard: ["theme/screen.css"],
      stories: ["@example/a.css"],
    },
    expected: "@example/a.css v? · theme v?",
  },
])(
  "lists each stylesheet package once in page order and omits local paths",
  ({ lists, expected }) => {
    using fixture = testDirectory();
    expect(catalogStylesheetVersions(lists, fixture.folder)).toBe(expected);
  },
);

test.each([
  {
    tokens: { "--space": "", "--invalid": 4, "--tone": "white" },
    expected: { "--space": "", "--tone": "white" },
  },
])("retains an empty string token while discarding non-string tokens", ({ tokens, expected }) => {
  const require = catalogRequire();
  vi.mocked(require).mockReturnValue({ tokens });
  expect(catalogBrandTokens(require)).toEqual(expected);
});

test.each([{ root: "/fixture", input: './quoted".astro', expected: '"/fixture/quoted\\".astro"' }])(
  "quotes a relative component specifier after resolving it from the Astro root",
  ({ root, input, expected }) => {
    expect(catalogModuleSpecifier(root, input)).toBe(expected);
  },
);

test.each([
  {
    around: ["./one.css", "./two.css"],
    expected:
      'import c0 from "/fixture/one.css?inline";import c1 from "/fixture/two.css?inline";export default c0+c1;',
  },
])("concatenates inlined chrome modules in stylesheet order", ({ around, expected }) => {
  const lists = { home: [], dashboard: [], stories: [] };
  expect(
    catalogStylesheetModules("/fixture", lists, around)["virtual:scaffolding/catalog-around"],
  ).toBe(expected);
});

test.each([
  {
    css: "\n @layer reset, elements; \n",
    expected:
      "@layer hw-catalog-ground;@layer reset, elements;@layer hw-catalog-ground{[data-hw-alone] main{padding:var(--hw-focus-room)}}",
  },
])(
  "places trimmed brand layer declarations before the catalog focus room rule",
  ({ css, expected }) => {
    using fixture = testDirectory();
    const file = join(fixture.folder, "layers.css");
    writeFileSync(file, css);
    const require = catalogRequire();
    vi.mocked(require.resolve).mockReturnValue(file);
    expect(catalogBrandLayers(require)).toBe(expected);
  },
);

test.each([
  {
    component: "./Own.astro",
    expected: 'export { default } from "@hackersandwizards/brand/logos/favicon.svg?url&no-inline";',
  },
])("asks Vite for a favicon URL even when the source SVG is small", ({ component, expected }) => {
  using fixture = testDirectory();
  const mount = new CatalogMount();
  mount.configureMount(catalogSetupEvent(fixture.folder, "/site"));
  const require = catalogRequire();
  vi.mocked(require.resolve).mockReturnValue("/fixture/favicon.svg");
  const project = { ...readCatalogPackage(fixture.folder), require };
  const pages = new CatalogPageModules(sampleCatalog, mount, project);
  expect(pages.componentModules({ component }, false)["virtual:scaffolding/catalog-icon"]).toBe(
    expected,
  );
});

test.each([
  {
    css: "@layer reset;",
    expected: [
      "@hackersandwizards/brand/elements/focus.css",
      "htmlClass",
      "themeToggle",
      "@hackersandwizards/brand/expert/components/ThemeToggle.astro",
      "homeCss",
      "header",
      "nav",
      "@hackersandwizards/brand/tokens.json",
      "header.css",
      "title",
      "@hackersandwizards/brand/layers.css",
      "trailingSlash",
      "head",
      "@hackersandwizards/brand/logos/favicon.svg",
    ],
  },
])("reads page options and brand exports in setup order", ({ css, expected }) => {
  using fixture = testDirectory();
  const { folder } = fixture;
  const file = join(folder, "layers.css");
  writeFileSync(file, css);
  const reads: string[] = [];
  const require = catalogRequire();
  vi.mocked(require).mockImplementation((id: string) => {
    reads.push(id);
    return { tokens: {} };
  });
  vi.mocked(require.resolve).mockImplementation((id) => {
    reads.push(id);
    return file;
  });
  const options = {
    ...sampleCatalog,
    get htmlClass() {
      reads.push("htmlClass");
      return ["hw-focus-ring"];
    },
    get themeToggle() {
      reads.push("themeToggle");
      return true;
    },
    get homeCss() {
      reads.push("homeCss");
      return [];
    },
    get header() {
      reads.push("header");
      return {
        component: "./Header.astro",
        get css() {
          reads.push("header.css");
          return [];
        },
      };
    },
    get nav() {
      reads.push("nav");
      return { items: [] };
    },
    get title() {
      reads.push("title");
      return "Sample catalog";
    },
    get head() {
      reads.push("head");
      return "./Head.astro";
    },
  };
  const mount = new CatalogMount();
  const params = mount.configureMount(catalogSetupEvent(folder, "/site"));
  Object.defineProperty(params.config, "trailingSlash", {
    get() {
      reads.push("trailingSlash");
      return "always";
    },
  });
  const project = { ...readCatalogPackage(folder), require };
  new CatalogPageModules(options, mount, project).sources(params);
  expect(reads).toEqual(expected);
});
