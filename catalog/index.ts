// The shell depends on no brand package: brand's header and CSS are named as strings the
// repository resolves.
import astrobook from "astrobook";
import type { AstroIntegration } from "astro";
import {
  cpSync,
  createReadStream,
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogPath, storiesDir } from "./path.ts";

export { renderCatalog } from "./render.ts";
export type { CatalogData, CatalogGroup, CatalogItem } from "./render.ts";

export type CatalogOptions = {
  /** The product name in the header, such as "Dokumente". */
  product: string;
  /** The stylesheets every catalog page loads, in order: brand's exports and the repository's own. */
  css: string[];
  /** One or two sentences under the title. */
  lead: string;
  /** The tile preview's viewport in CSS px, drawn whole and scaled to the tile, such as
   * [1440, 810] for a slide, or one per group, such as { Pages: [1440, 900] }; without one the
   * first state draws at three quarters, centred. */
  previewSize?: [number, number] | Record<string, [number, number]>;
  /** brand's data-hw-scale on <html> of every page that draws a story (a state's page and the
   * state alone), such as "screen"; without it such a page keeps what the repository's head sets,
   * else brand's default. The home draws at "dense". */
  storyScale?: string;
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
  /** Under `astro dev`, a header link to the repository's page in the local admin hub,
   * http://admin.localhost:4329/<repo>/dashboard, the repo named as the hub names it. */
  admin?: boolean;
  /** Draw each tile's first state; off for states that load slowly or may not be framed. */
  previews?: boolean;
  /** The repository's <head> component, relative to the Astro root, rendered on every page inside
   * the shell's Head.astro. */
  head?: string;
  /** The repository's own home page, relative to the Astro root, rendering Home.astro with its
   * foundations; without it the shell's Home.astro is the home. */
  home?: string;
  /** An Astro component taking `product`, `href` and a default slot, and the CSS it needs;
   * a relative path counts from the Astro root. */
  header?: { component: string; css?: string[] };
  /** Files the built pages reach by a relative path rather than through Vite, such as brand's
   * stylesheets and logos under node_modules: globs relative to the repository, each match copied
   * into the build at the same relative path, symlinks followed, and served at that path by `dev`.
   * In CI (`CI=true`) a copied file that is still a Git LFS pointer fails the build, so a published
   * page never links one. */
  copy?: string[];
  /** Every story is an Astro component: render each frame on the server only, dropping Astrobook's
   * `client:load` branch for framework components, which bundles every story module for the
   * browser, Node imports included. */
  serverOnly?: boolean;
};

const BRAND_HEADER = {
  component: "@hackersandwizards/brand/expert/components/AppHeader.astro",
  css: ["@hackersandwizards/brand/header.css"],
};
const OPTIONS = "virtual:scaffolding/catalog";
const HEADER = "virtual:scaffolding/catalog-header";
const HEAD = "virtual:scaffolding/catalog-head";

/** The nearest folder at or above `from` holding a package.json. */
function packageDir(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

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
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).version;
    if (dirname(dir) === dir) return undefined;
  }
}

const POINTER = "version https://git-lfs.github.com/spec/";
const isPointer = (file: string) =>
  readFileSync(file).subarray(0, POINTER.length).toString() === POINTER;

// A stylesheet or font served without its type is refused by the browser.
const TYPES: Record<string, string> = {
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  pdf: "application/pdf",
};
const mime = (file: string) =>
  TYPES[file.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

const decoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
};

const packageOf = (spec: string) =>
  spec.startsWith(".") || spec.startsWith("/")
    ? undefined
    : spec
        .split("/")
        .slice(0, spec.startsWith("@") ? 2 : 1)
        .join("/");

// Astrobook's layout loads Astro's client router; found only when the first page loads, these
// modules made Vite optimise again and print it after every start whose lockfile had changed.
const ROUTER = ["events", "router", "swap-functions", "types"].map(
  (m) => `astro/virtual-modules/transitions-${m}.js`,
);

export function catalog(options: CatalogOptions): AstroIntegration {
  let inner: AstroIntegration | undefined;
  let repo = "";
  let base = "";
  let atRoot = false;
  let mounted = false;
  // Where an old link points, as dev serves it now: without the Pages base, and without /catalog
  // where the catalog moved to the root; undefined for a current path.
  let moved = (_: string): string | undefined => undefined;
  return {
    name: "@hackersandwizards/scaffolding/catalog",
    hooks: {
      "astro:config:setup": async (inParams) => {
        // `base` exists for the Pages host only (https://<owner>.github.io/<repo>/): dev serves at
        // the root.
        const dev = inParams.command === "dev";
        const pagesBase = inParams.config.base.replace(/\/$/, "");
        // A base ending in /catalog mounts the catalog under a host with its own home, which serves
        // public/ itself and never had the catalog at its root.
        mounted = pagesBase.endsWith("/catalog");
        const params = dev
          ? { ...inParams, config: inParams.updateConfig({ base: "/" }) }
          : inParams;
        const root = fileURLToPath(params.config.root);
        const publicDir = fileURLToPath(params.config.publicDir);
        const own = basename(root) === "catalog";
        repo = packageDir(root);
        base = params.config.base.replace(/\/$/, "");
        const pages = join(fileURLToPath(params.config.srcDir), "pages");
        atRoot =
          catalogPath({ base, pages: existsSync(pages) ? readdirSync(pages) : [] }) === `${base}/`;
        if (atRoot && params.config.redirects["/"])
          throw new Error(
            'catalog: the catalog is the site\'s home, so `redirects` leaves out "/"; its former /catalog/ pages forward by themselves',
          );
        const strip = (p: string, prefix: string) =>
          prefix && (p === prefix || p.startsWith(`${prefix}/`))
            ? p.slice(prefix.length) || "/"
            : p;
        moved = (path) => {
          const unbased = strip(path, dev ? pagesBase : "");
          // Only the catalog's own former pages move, as in the build: a site's page under
          // /catalog/ stays.
          const now =
            atRoot && /^\/catalog(\/(dashboard|stories)(\/|$)|\/?$)/.test(unbased)
              ? strip(unbased, "/catalog")
              : unbased;
          // A file Vite serves, a module under the root such as catalog/Head.astro or a public
          // file, is not a page.
          const file = decoded(path);
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
        const stories = storiesDir(root);
        const pkgFile = join(repo, "package.json");
        const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, "utf8")) : {};
        const name = String(pkg.name ?? basename(repo)).replace(/^@[^/]+\//, "");
        const versions = [...new Set(options.css.map(packageOf).filter((p) => p !== undefined))]
          .map((p) => `${p} v${installed(p, root) ?? "?"}`)
          .join(" · ");
        const provenance = [`${name} ${relative(repo, stories)}`, versions]
          .filter(Boolean)
          .join(" · ");
        const header = options.header ?? BRAND_HEADER;
        // A relative specifier counts from the Astro root, as Astrobook reads `head` and `home`.
        const spec = (s: string) => JSON.stringify(s.startsWith(".") ? join(root, s) : s);
        const shared = {
          product: options.product,
          href: options.href ?? `${base}/`,
          title: options.title ?? "Catalog",
          lead: options.lead,
          previews: options.previews ?? true,
          previewSize: options.previewSize,
          storyScale: options.storyScale,
          groupOrder: options.groupOrder ?? [],
          previewStates: options.previewStates ?? [],
          provenance,
          // The hub serves only on this machine, so a published page carries no link to it.
          admin:
            dev && options.admin
              ? `http://admin.localhost:4329/${encodeURIComponent(pkg.admin?.name ?? checkout(repo))}/dashboard`
              : undefined,
        };
        params.updateConfig({
          // Astro's own default only: an outDir the config sets stays.
          ...(own &&
            params.config.outDir.href === new URL("dist/", params.config.root).href && {
              outDir: new URL("../dist/", params.config.root),
            }),
          vite: {
            ...(mounted && !dev && { publicDir: false as const }),
            optimizeDeps: {
              entries: [`${relative(root, stories)}/**/*.stories.*`],
              include: ROUTER,
            },
            plugins: [
              {
                name: "scaffolding-catalog",
                resolveId: (id: string) =>
                  id === OPTIONS || id === HEADER || id === HEAD ? `\0${id}` : undefined,
                load: (id: string) =>
                  id === `\0${OPTIONS}`
                    ? `export default ${JSON.stringify(shared)};`
                    : id === `\0${HEADER}`
                      ? `${(header.css ?? []).map((c) => `import ${spec(c)};`).join("")}export { default } from ${spec(header.component)};`
                      : id === `\0${HEAD}`
                        ? `export { default } from ${spec(options.head ?? "astrobook/components/head.astro")};`
                        : undefined,
              },
            ],
          },
        });
        inner = astrobook({
          directory: relative(root, stories),
          subpath: atRoot ? "" : "/catalog",
          title: `${options.product} catalog`,
          css: options.css,
          head: join(import.meta.dirname, "Head.astro"),
          home: options.home ?? join(import.meta.dirname, "Home.astro"),
        });
        await inner.hooks["astro:config:setup"]?.(params);
        if (options.serverOnly) {
          // Astrobook writes one route per state into this integration's codegen folder.
          const dir = fileURLToPath(params.createCodegenDir());
          for (const file of globSync("**/*.astro", { cwd: dir })) {
            const path = join(dir, file);
            writeFileSync(path, readFileSync(path, "utf8").replace(" client:load />", " />"));
          }
        }
      },
      "astro:server:setup": ({ server }) => {
        server.middlewares.use((req, res, next) => {
          const url = URL.parse(req.url ?? "", "http://x");
          const to = moved(url?.pathname ?? "");
          const path = decoded(url?.pathname ?? "");
          if (to) {
            // Temporary: dev ports pass between repositories, and a browser keeps a 301 for the port.
            res.writeHead(307, { Location: `${to}${url!.search}` });
            return res.end();
          }
          const file = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : "";
          const served = (options.copy ?? [])
            .flatMap((pattern) => globSync(pattern, { cwd: repo }))
            .some((match) => file === match || file.startsWith(`${match}/`));
          const full = join(repo, file);
          if (
            !served ||
            file.split("/").includes("..") ||
            !statSync(full, { throwIfNoEntry: false })?.isFile()
          )
            return next();
          res.setHeader("Content-Type", mime(file));
          createReadStream(full).pipe(res);
        });
      },
      "astro:server:start": async (params) => {
        await inner?.hooks["astro:server:start"]?.(params);
      },
      "astro:build:done": ({ dir }) => {
        const out = fileURLToPath(dir);
        // The catalog lived under /catalog/ until v2.0.0: each of its published pages forwards.
        if (atRoot && !mounted)
          for (const page of globSync(["index.html", "{dashboard,stories}/**/index.html"], {
            cwd: out,
          })) {
            const to = encodeURI(`${base}/${dirname(page) === "." ? "" : `${dirname(page)}/`}`);
            const stub = join(out, "catalog", page);
            if (existsSync(stub)) continue;
            mkdirSync(dirname(stub), { recursive: true });
            writeFileSync(
              stub,
              `<!doctype html><meta charset="utf-8"><title>Moved</title><meta name="robots" content="noindex"><link rel="canonical" href="${to}"><meta http-equiv="refresh" content="0; url=${to}"><script>location.replace(${JSON.stringify(to)}+location.search+location.hash)</script><a href="${to}">${to}</a>\n`,
            );
          }
        const pointers: string[] = [];
        for (const pattern of options.copy ?? []) {
          const found = globSync(pattern, { cwd: repo });
          if (found.length === 0) throw new Error(`catalog copy: ${pattern} matches nothing`);
          for (const file of found) {
            const target = join(out, file);
            cpSync(join(repo, file), target, { recursive: true, dereference: true });
            const copied = statSync(target).isDirectory()
              ? readdirSync(target, { recursive: true, encoding: "utf8" }).map((f) => join(file, f))
              : [file];
            for (const f of copied)
              if (statSync(join(out, f)).isFile() && isPointer(join(out, f))) pointers.push(f);
          }
        }
        // Only in CI: locally a pointer may be a file .lfsconfig leaves out.
        if (process.env.CI === "true" && pointers.length)
          throw new Error(`catalog copy: still Git LFS pointers: ${pointers.join(", ")}`);
      },
    },
  };
}
