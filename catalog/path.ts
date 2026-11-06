import { basename, join } from "node:path";

/** The catalog's stories in the Astro app at `root`: catalog/stories, or stories/ where the root is
 * itself catalog/. */
export const storiesDir = (root: string) =>
  join(root, basename(root) === "catalog" ? "stories" : "catalog/stories");

/**
 * Where the catalog serves, with a trailing slash: the site's root, or `/catalog/` where the site
 * has a home of its own, which Astrobook's static "/" would shadow: an index page or folder, or a
 * top-level catch-all, among `pages`, the entries of Astro's `srcDir/pages`. Under `astro dev`
 * the base drops, as the preset serves dev at the root.
 */
export function catalogPath({
  base = "",
  pages,
  dev = false,
}: {
  base?: string;
  pages: string[];
  dev?: boolean;
}): string {
  const home = pages.some((f) => /^(index(\.|$)|\[\.\.\.)/.test(f));
  return `${dev ? "" : base.replace(/\/$/, "")}${home ? "/catalog" : ""}/`;
}
