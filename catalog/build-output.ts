import type { AstroIntegration } from "astro";
import { existsSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CatalogMount } from "./mount.ts";
import { decodeCatalogPath } from "./path.ts";
import { SUBPATHS } from "./route.ts";

export function writeCatalogForwarders(out: string, base: string): void {
  // The catalog lived under /catalog/ until v2.0.0: each of its published pages forwards. A
  // build opened from disk was never published there.
  for (const page of globSync(
    ["index.html", `{${Object.values(SUBPATHS).join(",")}}/**/index.html`],
    {
      cwd: out,
    },
  )) {
    const to = encodeURI(`${base}/${dirname(page) === "." ? "" : `${dirname(page)}/`}`);
    const stub = join(out, "catalog", page);
    if (existsSync(stub)) continue;
    mkdirSync(dirname(stub), { recursive: true });
    writeFileSync(
      stub,
      `<!doctype html><meta charset="utf-8"><title>Moved</title><link rel="canonical" href="${to}"><meta http-equiv="refresh" content="0; url=${to}"><script>location.replace(${JSON.stringify(to)}+location.search+location.hash)</script><a href="${to}">${to}</a>\n`,
    );
  }
}

export function catalogFileLinks(html: string, out: string, base: string): string {
  let linked = "";
  let cursor = 0;
  for (const match of html.matchAll(
    /(\s(?:href|src|data-src|value)=")(\/(?!\/)[^"?#]*)([^"]*")/g,
  )) {
    const [, attr, path, rest] = match;
    if (path !== base && !path!.startsWith(`${base}/`)) continue;
    const at = decodeCatalogPath(path!.slice(base.length + 1));
    if (at.split("/").includes("..")) continue;
    const target = [at, join(at, "index.html"), `${at.replace(/\/$/, "")}.html`]
      .map((file) => join(out, file))
      .find((file) => statSync(file, { throwIfNoEntry: false })?.isFile());
    if (!target) continue;
    linked += `${html.slice(cursor, match.index)}${attr}${pathToFileURL(target).href}${rest}`;
    cursor = match.index + match[0].length;
  }
  return linked + html.slice(cursor);
}

type BuildAssets = Parameters<
  NonNullable<AstroIntegration["hooks"]["astro:build:done"]>
>[0]["assets"];

// Opened from disk, each link to a page or file of the build, a state menu's option included,
// names its file by file URL, as Astro names the assets, since a folder there opens as a
// listing, not its index.html. Last, once every `copy` entry is in place.
export function rewriteCatalogOutput(
  assets: BuildAssets,
  out: string,
  { base, pageRoutes }: Pick<CatalogMount, "base" | "pageRoutes">,
): void {
  for (const [pattern, urls] of assets) {
    if (!pageRoutes.has(pattern)) continue;
    for (const url of urls) {
      if (!url.pathname.endsWith(".html")) continue;
      const file = fileURLToPath(url);
      const html = readFileSync(file, "utf8");
      const linked = catalogFileLinks(html, out, base);
      if (linked !== html) writeFileSync(file, linked);
    }
  }
}
