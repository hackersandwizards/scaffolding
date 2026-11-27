import { basename, join } from "node:path";

/** The catalog's stories in the Astro app at `root`: catalog/stories, or stories/ where the root is
 * itself catalog/. */
export const storiesDir = (root: string) =>
  join(root, basename(root) === "catalog" ? "stories" : "catalog/stories");

export const catalogStoryGlob = (stories: string) => `${stories}/**/*.stories.*`;
export const catalogPagesDir = (source: string) => join(source, "pages");
export const catalogHead = "Head.astro";
export const catalogHome = "Home.astro";
