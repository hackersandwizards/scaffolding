import astrobook from "astrobook";
import type { AstroIntegration } from "astro";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteCatalogOutput, writeCatalogForwarders } from "./build-output.ts";
import { CatalogCopies, readCatalogPackage } from "./copy-assets.ts";
import { catalogAssetMiddleware, configureCatalogVite } from "./dev.ts";
import { CatalogMount, type CatalogSetupEvent } from "./mount.ts";
import { CatalogPageModules } from "./page-modules.ts";
import type { CatalogOptions } from "./index.ts";
import { SUBPATHS } from "./route.ts";

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
    const params = this.mount.configureMount(inParams);
    const { root, stories } = this.mount;
    const project = readCatalogPackage(this.mount.repo);
    this.copies.resolve(options.copy ?? [], project);
    configureCatalogVite(params, this.mount, new CatalogPageModules(options, this.mount, project));
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
    catalogAssetMiddleware(server, this.options.copy ?? [], this);
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
