# Exporting `const prerender` outside an Astro page file has no effect.

Find which page file under `pages` imports this module or renders this route. Move `export const prerender` into that page and remove it here so its rendering mode takes effect. Delete it without moving only after confirming the page already sets the intended mode.

No fix: deleting the export without checking which page it was meant to configure.
