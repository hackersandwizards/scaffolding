# `Astro.canonicalURL` has been removed from Astro.

Build the canonical URL with `new URL(Astro.url.pathname, Astro.site)` instead, and ensure `site` is set in `astro.config` so `Astro.site` supplies the base URL.

No fix: using `Astro.url` on its own, which keeps the request's host and query string.
