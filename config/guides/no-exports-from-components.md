# Runtime exports from an `.astro` component other than types or Astro's own exports are unavailable to importers.

Keep only types and exports Astro reads, such as `getStaticPaths` and `prerender`. Check for callers needing the exported value, move it to a `.ts` module, and import it in both the component and its callers.

No fix: dropping `export` without checking callers, or copying the value into each file that used it.
