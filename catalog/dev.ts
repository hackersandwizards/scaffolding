import { createReadStream, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";
import { ownEntry } from "../lib/own-entry.ts";
import { brandFallbacks } from "./fallbacks.ts";
import { catalogAssetMime, catalogCopyPrefixes, type CatalogCopies } from "./copy-assets.ts";
import type { CatalogAstroHooks } from "./hooks.ts";
import type { CatalogMount, CatalogSetupEvent } from "./mount.ts";
import type { CatalogPageModules } from "./page-modules.ts";
import { decodeCatalogPath } from "./path.ts";
import { loadRoute, retitleLayout } from "./route.ts";

// Astrobook's layout loads Astro's client router; found only when the first page loads, these
// modules make Vite optimise again and print it after every start whose lockfile has changed.
const ROUTER = ["events", "router", "swap-functions", "types"].map(
  (m) => `astro/virtual-modules/transitions-${m}.js`,
);

export function configureCatalogVite(
  params: CatalogSetupEvent,
  mount: CatalogMount,
  pages: CatalogPageModules,
) {
  const { root, own, dev, stories } = mount;
  const { modules, tokens } = pages.sources(params);
  const { options } = pages;
  const codegen = fileURLToPath(params.createCodegenDir());
  params.updateConfig({
    // Astro's own default only: an outDir the config sets stays.
    ...(own &&
      params.config.outDir.href === new URL("dist/", params.config.root).href && {
        outDir: new URL("../dist/", params.config.root),
      }),
    vite: {
      ...(mount.mounted && !dev && { publicDir: false as const }),
      optimizeDeps: {
        entries: [`${relative(root, stories)}/**/*.stories.*`],
        include: ROUTER,
      },
      plugins: [
        {
          // Ahead of Vite's CSS plugin, which reads the file's text.
          name: "scaffolding-catalog-fallbacks",
          enforce: "pre" as const,
          // Astrobook's layout and the routes it writes into this integration's codegen
          // folder, one per state, as loaded, before Astro compiles them: each page gets its
          // own title, each route its CSS. The bare file only: its <style> blocks come as
          // queries on the same path.
          load: (id: string) => {
            if (id.endsWith("/@astrobook/ui/dist/components/layout.astro"))
              return retitleLayout(readFileSync(id, "utf8"), join(import.meta.dirname, "words.ts"));
            const file = relative(codegen, id);
            return id.endsWith(".astro") && !file.startsWith("..")
              ? loadRoute(id, file, options.serverOnly ?? false)
              : undefined;
          },
          // Every stylesheet beside this file is the shell's.
          transform: (code: string, id: string) => {
            const file = id.split("?")[0]!;
            return dirname(file) === import.meta.dirname && file.endsWith(".css")
              ? brandFallbacks(code, tokens)
              : undefined;
          },
        },
        {
          name: "scaffolding-catalog",
          resolveId: (id: string) => (Object.hasOwn(modules, id) ? `\0${id}` : undefined),
          load: (id: string) => (id.startsWith("\0") ? ownEntry(modules, id.slice(1)) : undefined),
        },
      ],
    },
  });
}

export class CatalogDevAssets {
  private readonly fixed: [string, string][];

  private readonly mount: CatalogMount;
  private readonly copies: CatalogCopies;

  constructor(mount: CatalogMount, copies: CatalogCopies, patterns: string[]) {
    this.mount = mount;
    this.copies = copies;
    this.fixed = catalogCopyPrefixes(patterns);
  }

  respond(path: string, res: import("node:http").ServerResponse): boolean {
    const { base } = this.mount;
    const file = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : "";
    if (!file || !this.fixed.length) return false;
    const full = this.copies.servePath(file, this.fixed);
    if (!full) return false;
    res.setHeader("Content-Type", catalogAssetMime(file));
    createReadStream(full).pipe(res);
    return true;
  }
}

type Server = Parameters<NonNullable<AstroIntegration["hooks"]["astro:server:setup"]>>[0]["server"];

export function catalogAssetMiddleware(
  server: Server,
  patterns: string[],
  site: CatalogAstroHooks,
) {
  const { mount, copies } = site;
  const assets = new CatalogDevAssets(mount, copies, patterns);
  server.middlewares.use((req, res, next) => {
    const url = URL.parse(req.url ?? "", "http://x");
    const to = mount.moved(url?.pathname ?? "");
    const path = decodeCatalogPath(url?.pathname ?? "");
    if (to) {
      // Temporary: dev ports pass between repositories, and a browser keeps a 301 for the port.
      res.writeHead(307, { Location: `${to}${url!.search}` });
      return res.end();
    }
    if (!assets.respond(path, res)) return next();
  });
}
