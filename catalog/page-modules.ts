import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { isObject, jsonObject } from "../lib/json.ts";
import { catalogPackageOf, type readCatalogPackage } from "./copy-assets.ts";
import type { CatalogOptions, CatalogRuntimeConfig } from "./index.ts";
import type { CatalogMount, CatalogSetupEvent } from "./mount.ts";
import { CSS } from "./route.ts";

const BRAND_HEADER = {
  component: "@hackersandwizards/brand/expert/components/AppHeader.astro",
  // night.css turns the header under the data-hw-night that Head.astro sets.
  css: ["@hackersandwizards/brand/header.css", "@hackersandwizards/brand/night.css"],
};
const OPTIONS = "virtual:scaffolding/catalog";
const HEADER = "virtual:scaffolding/catalog-header";
const HEAD = "virtual:scaffolding/catalog-head";
const AROUND = "virtual:scaffolding/catalog-around";
const ICON = "virtual:scaffolding/catalog-icon";
const BRAND_ICON = "@hackersandwizards/brand/logos/favicon.svg";
// The cascade layer order alone, exported since brand v1.52.0.
const BRAND_LAYERS = "@hackersandwizards/brand/layers.css";
const BRAND_FOCUS = "@hackersandwizards/brand/elements/focus.css";
const BRAND_TOGGLE = "@hackersandwizards/brand/expert/components/ThemeToggle.astro";
const TOGGLE = "virtual:scaffolding/catalog-toggle";

/** The repository's name as the admin hub keys it: its checkout's folder, a worktree's main
 * checkout (the worktree's own folder names a branch), else the package folder outside Git. */
function checkout(dir: string): string {
  const [top, common] =
    spawnSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      { cwd: dir, encoding: "utf8" },
    ).stdout?.split("\n") ?? [];
  return basename(common?.endsWith("/.git") ? dirname(common) : top || dir);
}

/** The installed version of a package, read from the nearest node_modules holding it. */
function installed(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const file = join(dir, "node_modules", name, "package.json");
    if (existsSync(file)) {
      const { version } = jsonObject(readFileSync(file));
      return typeof version === "string" ? version : undefined;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** What `read` takes from brand; undefined only where brand is missing. Every brand the shell
 * accepts (v2.5.0 and later) exports each path read here, so an export it drops fails the build. */
function fromBrand(read: () => unknown): unknown {
  try {
    return read();
  } catch (e) {
    if ((e as { code?: string }).code === "MODULE_NOT_FOUND") return undefined;
    throw e;
  }
}

/** brand's list of catalogs as the header's nav, the one named `product` current; none where the
 * repository cannot resolve it. */
function brandNav(
  require: ReturnType<typeof createRequire>,
  product: string,
): CatalogOptions["nav"] {
  const listed = fromBrand(() => require("@hackersandwizards/brand/catalogs.json"));
  if (listed === undefined) return undefined;
  const isItem = (item: unknown): item is { name: string; href: string } =>
    isObject(item) && typeof item.name === "string" && typeof item.href === "string";
  if (!Array.isArray(listed) || !listed.every(isItem))
    throw new Error("@hackersandwizards/brand/catalogs.json lists no { name, href } items");
  return {
    items: listed,
    current: listed.some(({ name }) => name === product) ? product : undefined,
  };
}

type Project = ReturnType<typeof readCatalogPackage>;
type Require = ReturnType<typeof createRequire>;

export function checkCatalogBrandVersion(root: string): void {
  // The shell's type steps are brand's tokens.json --text-* names (brand v2.5.0) and the focus
  // ring's room is brand's --hw-focus-room (v2.10.0): an older brand leaves them bare, the text
  // at inherited sizes and a ring cut at <main>'s edge, with no error of its own.
  const brand = installed("@hackersandwizards/brand", root)?.split(".").map(Number);
  if (brand && (brand[0] ?? 0) * 1000 + (brand[1] ?? 0) < 2010)
    throw new Error(
      `catalog: the shell needs @hackersandwizards/brand v2.10.0 or later, installed is v${brand.join(".")}`,
    );
}

export class CatalogFocusRing {
  readonly htmlClass: string[];
  readonly stylesheets: string[];

  constructor(options: Pick<CatalogOptions, "htmlClass">, require: Require) {
    const focus = fromBrand(() => require.resolve(BRAND_FOCUS));
    this.htmlClass = options.htmlClass ?? (focus ? ["hw-focus-ring"] : []);
    // brand's hw-focus-ring draws nothing without its focus.css, which a slim list leaves out.
    // First, so the lists' own sheets, brand's elements.css among them, still follow it.
    this.stylesheets = this.htmlClass.includes("hw-focus-ring") && focus ? [BRAND_FOCUS] : [];
  }
}

export function catalogToggleComponent(themeToggle: boolean, require: Require): boolean {
  return themeToggle && !!fromBrand(() => require.resolve(BRAND_TOGGLE));
}

export function catalogAroundStylesheets(header: NonNullable<CatalogOptions["header"]>): string[] {
  return [
    join(import.meta.dirname, "ground.css"),
    ...(header.css ?? []),
    join(import.meta.dirname, "chrome.css"),
  ];
}

export function catalogStylesheetLists(options: CatalogOptions, ring: string[]) {
  const withRing = (list: string[]) => [...new Set([...ring, ...list])];
  return {
    home: withRing(options.homeCss ?? options.css),
    dashboard: withRing(options.dashboardCss ?? options.css),
    stories: withRing(options.css),
  };
}

export function catalogStylesheetVersions(
  lists: ReturnType<typeof catalogStylesheetLists>,
  root: string,
): string {
  const sheets = Object.values(lists).flat();
  return [...new Set(sheets.map(catalogPackageOf).filter((p) => p !== undefined))]
    .map((p) => `${p} v${installed(p, root) ?? "?"}`)
    .join(" · ");
}

export function catalogBrandTokens(require: Require): Record<string, string> {
  const brandTokens = fromBrand(() => require("@hackersandwizards/brand/tokens.json"));
  return Object.fromEntries(
    Object.entries(
      isObject(brandTokens) && isObject(brandTokens.tokens) ? brandTokens.tokens : {},
    ).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

// A relative specifier counts from the Astro root, as Astrobook reads `head` and `home`.
export function catalogModuleSpecifier(root: string, specifier: string): string {
  return JSON.stringify(specifier.startsWith(".") ? join(root, specifier) : specifier);
}

export function catalogStylesheetModules(
  root: string,
  lists: ReturnType<typeof catalogStylesheetLists>,
  around: string[],
): Record<string, string> {
  const imports = (list: string[]) =>
    list.map((c) => `import ${catalogModuleSpecifier(root, c)};`).join("");
  return {
    // Inlined on the home and a state's page: linked, one more render-blocking request.
    [AROUND]: `${around.map((c, i) => `import c${i} from ${catalogModuleSpecifier(root, `${c}?inline`)};`).join("")}export default ${around.map((_, i) => `c${i}`).join("+")};`,
    [`${CSS}home`]: imports(lists.home),
    [`${CSS}dashboard`]: imports(lists.dashboard),
    [`${CSS}stories`]: imports(lists.stories),
  };
}

// Ahead of every stylesheet, which the build puts at the head's end. A state alone in the
// window, not in a tile's frame, gets the focus ring's room (brand v2.10.0's
// --hw-focus-room, elements/focus.css) inside Astrobook's <main>, whose scroll box cut a
// ring at x = 0.
export function catalogBrandLayers(require: Require): string {
  return (
    "@layer hw-catalog-ground;" +
    (fromBrand(() => readFileSync(require.resolve(BRAND_LAYERS), "utf8").trim()) ?? "") +
    "@layer hw-catalog-ground{[data-hw-alone] main{padding:var(--hw-focus-room)}}"
  );
}

export function validateCatalogHeader(htmlClass: string[], nav: CatalogOptions["nav"]): void {
  // classList.add throws on one of these, in the head of every page.
  if (htmlClass.some((c) => !/^\S+$/.test(c)))
    throw new Error("catalog htmlClass: one class per entry, without spaces");
  // A misspelt or renamed `current` would link this catalog's entry to the published site.
  if (nav?.current !== undefined && !nav.items.some(({ name }) => name === nav.current))
    throw new Error(`catalog nav: current "${nav.current}" names no item`);
}

export function catalogPageNav(
  nav: CatalogOptions["nav"],
  mount: Pick<CatalogMount, "base" | "link">,
): CatalogRuntimeConfig["nav"] {
  return nav?.items.map(({ name, href }) =>
    name === nav.current
      ? { name, href: mount.link, current: true }
      : { name, href: /^\/(?!\/)/.test(href) ? `${mount.base}${href}` : href },
  );
}

export function catalogStorySlash(config: CatalogSetupEvent["config"]): "/" | "" {
  // A story link ends in a slash where the site asks for one, or leaves it open and Astro
  // writes each page as a folder's index.html, which a static host serves only there.
  return config.trailingSlash === "always" ||
    (config.trailingSlash === "ignore" && config.build.format === "directory")
    ? "/"
    : "";
}

export function catalogAdminUrl(
  dev: boolean,
  options: CatalogOptions,
  { pkg, repo }: Project,
): string | undefined {
  // The hub serves only on this machine, so a published page carries no link to it.
  return dev && options.admin
    ? `http://admin.localhost:4329/${encodeURIComponent(isObject(pkg.admin) && typeof pkg.admin.name === "string" ? pkg.admin.name : checkout(repo))}/dashboard`
    : undefined;
}

export class CatalogPageModules {
  readonly options: CatalogOptions;
  private readonly mount: CatalogMount;
  private readonly project: Project;

  constructor(options: CatalogOptions, mount: CatalogMount, project: Project) {
    this.options = options;
    this.mount = mount;
    this.project = project;
  }

  sources(params: CatalogSetupEvent) {
    const { options, mount, project } = this;
    const { root, stories, base, link, onDisk, dev } = mount;
    const { name, repo, require } = project;
    checkCatalogBrandVersion(root);
    const focus = new CatalogFocusRing(options, require);
    const themeToggle = options.themeToggle ?? true;
    const toggle = catalogToggleComponent(themeToggle, require);
    const lists = catalogStylesheetLists(options, focus.stylesheets);
    const versions = catalogStylesheetVersions(lists, root);
    const provenance = [`${name} ${relative(repo, stories)}`, versions].filter(Boolean).join(" · ");
    const header = options.header ?? BRAND_HEADER;
    const nav = options.nav ?? brandNav(require, options.product);
    const tokens = catalogBrandTokens(require);
    const around = catalogAroundStylesheets(header);
    validateCatalogHeader(focus.htmlClass, nav);
    const runtime: CatalogRuntimeConfig = {
      product: options.product,
      href: options.href ?? `${base}/`,
      nav: catalogPageNav(nav, mount),
      link,
      title: options.title ?? "Catalog",
      lead: options.lead,
      previews: options.previews ?? true,
      previewSize: options.previewSize,
      themeToggle,
      // brand's switch in the header, where a state's page draws one too: the bar then offers none.
      headerToggle: toggle && !!nav,
      onDisk,
      storyScale: options.storyScale,
      htmlClass: focus.htmlClass,
      groupOrder: options.groupOrder ?? [],
      previewStates: options.previewStates ?? [],
      provenance,
      layers: catalogBrandLayers(require),
      slash: catalogStorySlash(params.config),
      admin: catalogAdminUrl(dev, options, project),
    };
    const modules: Record<string, string> = {
      [OPTIONS]: `export default ${JSON.stringify(runtime)};`,
      ...this.componentModules(header, toggle),
      ...catalogStylesheetModules(root, lists, around),
    };
    return { modules, tokens };
  }

  componentModules(header: NonNullable<CatalogOptions["header"]>, toggle: boolean) {
    const { root } = this.mount;
    const { require } = this.project;
    const spec = (specifier: string) => catalogModuleSpecifier(root, specifier);
    return {
      [HEADER]: `export { default } from ${spec(header.component)};`,
      [HEAD]: `export { default } from ${spec(this.options.head ?? "astrobook/components/head.astro")};`,
      [TOGGLE]: toggle
        ? `export { default } from ${spec(BRAND_TOGGLE)};`
        : "export default undefined;",
      [ICON]: fromBrand(() => require.resolve(BRAND_ICON))
        ? `export { default } from ${spec(`${BRAND_ICON}?url&no-inline`)};`
        : "export default undefined;",
    };
  }
}
