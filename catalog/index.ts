// The shell depends on no brand package: brand's header and CSS are named as strings the
// repository resolves.
import astrobook from "astrobook";
import type { AstroIntegration } from "astro";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteCatalogOutput, writeCatalogForwarders } from "./build-output.ts";
import { CatalogCopies, readCatalogPackage } from "./copy-assets.ts";
import { catalogAssetMiddleware, configureCatalogVite } from "./dev.ts";
import { CatalogMount, type CatalogSetupEvent } from "./mount.ts";
import { CatalogPageModules } from "./page-modules.ts";
import { storiesDir } from "./path.ts";
import { SUBPATHS } from "./route.ts";

export { renderCatalog } from "./render.ts";
export type { CatalogData, CatalogGroup, CatalogItem } from "./render.ts";

export type CatalogOptions = {
  /** The product name in the header, such as "Dokumente". */
  product: string;
  /** The stylesheets every page drawing a story loads, in order: brand's exports and the
   * repository's own. */
  css: string[];
  /** The stylesheets the home loads, default `css`: its tiles frame each state, so it needs only
   * the tokens, brand's fonts.css and elements.css its header, rail and tiles read and what its
   * foundations draw. */
  homeCss?: string[];
  /** The stylesheets a state's page loads, default `css`; less for stories that frame their state
   * alone there, which loads `css`: the tokens and fonts.css the header and bar read and what the
   * page draws. */
  dashboardCss?: string[];
  /** One or two sentences under the title. */
  lead: string;
  /** The tile preview's viewport in CSS px, drawn whole and scaled to the tile, such as
   * [1440, 810] for a slide, or one per group, such as { Pages: [1440, 900] }; without one the
   * first state draws at three quarters, centred. */
  previewSize?: [number, number] | Record<string, [number, number]>;
  /** brand's theme switch at the end of the header, where the repository resolves brand, else the
   * "Dark theme" button in a state's bar, and brand's night.css turning a page with either,
   * default true; false for a site without a dark theme. */
  themeToggle?: boolean;
  /** brand's data-hw-scale on <html> of every page that draws a story (a state's page and the
   * state alone), such as "screen"; without it such a page keeps what the repository's head sets,
   * else brand's default. The home draws at "dense". */
  storyScale?: string;
  /** Classes on <html> of every page, set before the body draws, default ["hw-focus-ring"] where the
   * repository resolves brand, else none; with that class every page also loads brand's
   * elements/focus.css. */
  htmlClass?: string[];
  /** Groups shown first, in this order; the rest follow alphabetically. */
  groupOrder?: string[];
  /** The states a tile draws and links, in order of preference, each the story's export name in
   * kebab case as Astrobook's id has it, such as ["light", "loaded-dark"]: Astrobook lists a
   * file's states alphabetically, so without it a tile draws "Dark" before "Light". A file with
   * none of them shows its first state. */
  previewStates?: string[];
  title?: string;
  /** Where the header's lockup links; default the site's root, Astro's `base`. */
  href?: string;
  /** The header's nav on every page but a state alone, such as brand's catalogs.json: an href
   * starting with "/" counts from Astro's `base`, and the item named `current` links to this
   * catalog, at /catalog/ after the base, and carries aria-current; a `current` naming no item
   * fails the build. Without it, brand's catalogs.json where the repository resolves
   * @hackersandwizards/brand, the item named `product` current. */
  nav?: { items: { name: string; href: string }[]; current?: string };
  /** Under `astro dev`, a header link to the repository's page in the local admin hub,
   * http://admin.localhost:4329/<repo>/dashboard, the repo named as the hub names it. */
  admin?: boolean;
  /** Draw each tile's first state; off for states that load slowly or may not be framed, and
   * "srcdoc" for a site whose pages refuse framing (X-Frame-Options): each tile draws its page's
   * HTML, fetched once the tile nears the view. */
  previews?: boolean | "srcdoc";
  /** The repository's <head> component, relative to the Astro root, rendered on every page inside
   * the shell's Head.astro. */
  head?: string;
  /** The repository's own home page, relative to the Astro root, rendering Home.astro with its
   * foundations in the default slot, drawn after the tiles as the group "Foundations"; without it
   * the shell's Home.astro is the home. */
  home?: string;
  /** An Astro component taking `product`, `href` and a default slot, and the CSS it needs;
   * a relative path counts from the Astro root. */
  header?: { component: string; css?: string[] };
  /** Files the built pages reach by a relative path rather than through Vite: globs relative to
   * the repository, each match copied into the build at the same relative path, symlinks followed,
   * and package paths, such as "@hackersandwizards/brand/logos/icon-maskable-512.png", of a package the
   * repository declares or of the repository itself, each resolved through the package's exports
   * and copied to that path. `dev` serves each at its path. In CI (`CI=true`) a copied file that is
   * still a Git LFS pointer fails the build, so a published page never links one. */
  copy?: string[];
  /** Every story is an Astro component: render each frame on the server only, dropping Astrobook's
   * `client:load` branch for framework components, which bundles every story module for the
   * browser, Node imports included. */
  serverOnly?: boolean;
};

export type CatalogRuntimeConfig = Required<
  Pick<
    CatalogOptions,
    | "product"
    | "href"
    | "title"
    | "lead"
    | "previews"
    | "themeToggle"
    | "htmlClass"
    | "groupOrder"
    | "previewStates"
  >
> &
  Pick<CatalogOptions, "previewSize" | "storyScale"> & {
    nav?: { name: string; href: string; current?: true }[];
    link: string;
    headerToggle: boolean;
    onDisk: boolean;
    provenance: string;
    layers: string;
    slash: "/" | "";
    admin?: string;
  };

export class CatalogAstroHooks {
  readonly mount = new CatalogMount();
  readonly copies = new CatalogCopies();
  inner: AstroIntegration | undefined;

  private readonly options: CatalogOptions;

  constructor(options: CatalogOptions) {
    this.options = options;
  }

  async configureCatalog(inParams: CatalogSetupEvent) {
    const { options } = this;
    const mount = this.mount.configureMount(inParams);
    const { params, root } = mount;
    const stories = storiesDir(root);
    const project = readCatalogPackage(this.mount.repo);
    this.copies.resolve(options.copy ?? [], project);
    configureCatalogVite(mount, new CatalogPageModules(options, mount, project), stories);
    this.inner = astrobook({
      directory: relative(root, stories),
      subpath: this.mount.atRoot ? "" : "/catalog",
      ...SUBPATHS,
      title: `${options.product} catalog`,
      css: [],
      head: join(import.meta.dirname, "Head.astro"),
      home: options.home ?? join(import.meta.dirname, "Home.astro"),
    });
    await this.inner.hooks["astro:config:setup"]?.(params);
  }

  catalogRoutes({
    routes,
  }: Parameters<NonNullable<AstroIntegration["hooks"]["astro:routes:resolved"]>>[0]) {
    const { pageRoutes } = this.mount;
    pageRoutes.clear();
    for (const route of routes) {
      if (route.type === "page") pageRoutes.add(route.pattern);
    }
  }

  catalogServer({
    server,
  }: Parameters<NonNullable<AstroIntegration["hooks"]["astro:server:setup"]>>[0]) {
    catalogAssetMiddleware(server, this.options, this);
  }

  async startCatalogServer(
    params: Parameters<NonNullable<AstroIntegration["hooks"]["astro:server:start"]>>[0],
  ) {
    await this.inner?.hooks["astro:server:start"]?.(params);
  }

  finishCatalogBuild({
    dir,
    assets,
  }: Parameters<NonNullable<AstroIntegration["hooks"]["astro:build:done"]>>[0]) {
    const out = fileURLToPath(dir);
    if (this.mount.forwards) writeCatalogForwarders(out, this.mount.base);
    this.copies.build(out, this.options.copy ?? []);
    if (this.mount.onDisk) rewriteCatalogOutput(assets, out, this.mount);
  }
}

export function catalog(options: CatalogOptions): AstroIntegration {
  const hooks = new CatalogAstroHooks(options);
  return {
    name: "@hackersandwizards/scaffolding/catalog",
    hooks: {
      "astro:config:setup": (params) => hooks.configureCatalog(params),
      "astro:routes:resolved": (params) => hooks.catalogRoutes(params),
      "astro:server:setup": (params) => hooks.catalogServer(params),
      "astro:server:start": (params) => hooks.startCatalogServer(params),
      "astro:build:done": (params) => hooks.finishCatalogBuild(params),
    },
  };
}
