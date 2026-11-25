# `Astro.fetchContent()` has been removed from Astro.

Replace `Astro.fetchContent()` with Astro content collections for structured content under `src/content`, or `import.meta.glob(..., { eager: true })` for direct file imports, verifying that the matched files and returned fields match what callers expect.

No fix: swapping in a broad glob without checking matched paths or the returned shape.
