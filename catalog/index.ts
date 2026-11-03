// The shell depends on no brand package: brand's header and CSS are named as strings the
// repository resolves.
import astrobook from "astrobook";
import type { AstroIntegration } from "astro";
import { cpSync, existsSync, globSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
   * [1440, 810] for a slide; without it the first state draws at three quarters. */
  previewSize?: [number, number];
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
   * into the build at the same relative path, symlinks followed. In CI (`CI=true`) a copied file
   * that is still a Git LFS pointer fails the build, so a published page never links one. */
  copy?: string[];
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

const packageOf = (spec: string) =>
  spec.startsWith(".") || spec.startsWith("/")
    ? undefined
    : spec
        .split("/")
        .slice(0, spec.startsWith("@") ? 2 : 1)
        .join("/");

export function catalog(options: CatalogOptions): AstroIntegration {
  let inner: AstroIntegration | undefined;
  let repo = "";
  return {
    name: "@hackersandwizards/scaffolding/catalog",
    hooks: {
      "astro:config:setup": async (params) => {
        const root = fileURLToPath(params.config.root);
        const own = basename(root) === "catalog";
        repo = packageDir(root);
        const stories = join(root, own ? "stories" : "catalog/stories");
        const name = (() => {
          const file = join(repo, "package.json");
          const pkg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
          return String(pkg.name ?? basename(repo)).replace(/^@[^/]+\//, "");
        })();
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
          href: options.href ?? `${params.config.base.replace(/\/$/, "")}/`,
          title: options.title ?? "Catalog",
          lead: options.lead,
          previews: options.previews ?? true,
          previewSize: options.previewSize,
          groupOrder: options.groupOrder ?? [],
          previewStates: options.previewStates ?? [],
          provenance,
        };
        params.updateConfig({
          ...(own && { outDir: new URL("../dist/", params.config.root) }),
          vite: {
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
          subpath: "/catalog",
          title: `${options.product} catalog`,
          css: options.css,
          head: join(import.meta.dirname, "Head.astro"),
          home: options.home ?? join(import.meta.dirname, "Home.astro"),
        });
        await inner.hooks["astro:config:setup"]?.(params);
      },
      "astro:server:start": async (params) => {
        await inner?.hooks["astro:server:start"]?.(params);
      },
      "astro:build:done": ({ dir }) => {
        const out = fileURLToPath(dir);
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
