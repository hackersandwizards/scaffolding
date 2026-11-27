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

export const decodeCatalogPath = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return "";
  }
};
