import type { AstroIntegration } from "astro";
import { existsSync, globSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogPagesDir, storiesDir } from "../lib/catalog-paths.ts";
import { catalogPath, decodeCatalogPath } from "./path.ts";
import { SUBPATHS } from "./route.ts";

export type CatalogSetupEvent = Parameters<
  NonNullable<AstroIntegration["hooks"]["astro:config:setup"]>
>[0];

const FORMER = new RegExp(`^/catalog(/(${Object.values(SUBPATHS).join("|")})(/|$)|/?$)`);
function packageDir(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

export function catalogUsesFileUrls(config: CatalogSetupEvent["config"], dev: boolean): boolean {
  const prefix = config.build.assetsPrefix;
  return (
    !dev &&
    (typeof prefix === "string" ? [prefix] : Object.values(prefix ?? {})).some((p) =>
      p.startsWith("file:"),
    )
  );
}

export function catalogForwardLink(base: string, home: string, pages: string): string {
  // Use the forwarding URL for the catalog home link unless the site already owns the /catalog/ route.
  return !globSync(["catalog.*", "catalog/index.*"], { cwd: pages }).length
    ? `${base}/catalog/`
    : home;
}

export function catalogRedirects(mount: CatalogMount) {
  const { root, publicDir, pagesBase, dev } = mount;
  const strip = (p: string, prefix: string) =>
    prefix && (p === prefix || p.startsWith(`${prefix}/`)) ? p.slice(prefix.length) || "/" : p;
  return (path: string) => {
    const unbased = strip(path, dev ? pagesBase : "");
    const own = mount.pageRoutes.has(decodeCatalogPath(unbased).replace(/(.)\/$/, "$1"));
    const now = mount.atRoot && !own && FORMER.test(unbased) ? strip(unbased, "/catalog") : unbased;
    // A file Vite serves, a module under the root such as catalog/Head.astro or a public
    // file, is not a page.
    const file = decodeCatalogPath(path);
    if (
      now === path ||
      (!file.split("/").includes("..") &&
        [root, publicDir].some((dir) =>
          statSync(join(dir, file), { throwIfNoEntry: false })?.isFile(),
        ))
    )
      return undefined;
    // "//host" in a Location header leaves the site.
    return now.replace(/^\/+/, "/");
  };
}

export class CatalogMount {
  root = "";
  publicDir = "";
  pagesBase = "";
  dev = false;
  own = false;
  link = "";
  stories = "";
  repo = "";
  base = "";
  atRoot = false;
  mounted = false;
  forwards = false;
  pageRoutes = new Set<string>();
  // A build whose assetsPrefix is a file URL is opened from disk, where a root-relative link
  // resolves to the disk's root.
  onDisk = false;
  // Where an old link points, as dev serves it now: without the Pages base, and without /catalog
  // where the catalog moved to the root; undefined for a current path.
  moved: (path: string) => string | undefined = () => undefined;

  configureMount(inParams: CatalogSetupEvent): CatalogSetupEvent {
    // `base` exists for the Pages host only (https://<owner>.github.io/<repo>/): dev serves at
    // the root.
    const dev = inParams.command === "dev";
    const pagesBase = inParams.config.base.replace(/\/$/, "");
    // A base ending in /catalog mounts the catalog under a host with its own home, which serves
    // public/ itself and never had the catalog at its root.
    this.mounted = pagesBase.endsWith("/catalog");
    const params = dev ? { ...inParams, config: inParams.updateConfig({ base: "/" }) } : inParams;
    const root = fileURLToPath(params.config.root);
    const publicDir = fileURLToPath(params.config.publicDir);
    const own = basename(root) === "catalog";
    this.repo = packageDir(root);
    const base = (this.base = params.config.base.replace(/\/$/, ""));
    this.onDisk = catalogUsesFileUrls(params.config, dev);
    const pages = catalogPagesDir(fileURLToPath(params.config.srcDir));
    const home = catalogPath({ base, pages: existsSync(pages) ? readdirSync(pages) : [] });
    this.atRoot = home === `${base}/`;
    this.forwards = this.atRoot && !this.mounted && !this.onDisk;
    const link = this.forwards ? catalogForwardLink(base, home, pages) : home;
    if (this.atRoot && params.config.redirects["/"])
      throw new Error(
        'catalog: the catalog is the site\'s home, so `redirects` leaves out "/"; its former /catalog/ pages forward by themselves',
      );
    this.root = root;
    this.publicDir = publicDir;
    this.pagesBase = pagesBase;
    this.dev = dev;
    this.own = own;
    this.link = link;
    this.moved = catalogRedirects(this);
    this.stories = storiesDir(root);
    return params;
  }
}
