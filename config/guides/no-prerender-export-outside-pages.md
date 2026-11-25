# Exporting `const prerender` outside an Astro page file has no effect.

Search the `pages` folder for the file that imports this module. Move `export const prerender` into that page file and remove it here so the page's rendering mode takes effect. Delete it without moving only after checking that page already exports `prerender` with the intended value.

No fix: deleting the export without finding and checking the target page file.
