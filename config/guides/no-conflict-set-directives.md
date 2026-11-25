# Combining `set:html`, `set:text`, or child elements on one Astro element creates conflicting content.

Check what content this element is meant to render. Keep that single source (`set:html`, `set:text`, or child markup) and delete the conflicting ones.

No fix: deleting child markup or whichever source is shortest without checking what should render.
