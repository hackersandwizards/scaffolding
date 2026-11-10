import { defineConfig } from "astro/config";
import { catalog } from "../../../catalog/index.ts";

export default defineConfig({
  integrations: [
    catalog({
      product: "Fx",
      css: ["./fx.css"],
      lead: "Lead.",
      groupOrder: ["Types", "Parts"],
      previewStates: ["block-image", "two"],
      previewSize: { Types: [1440, 900] },
      storyScale: "screen",
      htmlClass: ["fx-root", "fx-two"],
      header: { component: "./Header.astro", css: ["./header.css"] },
      // The tiles frame each state: the home takes none of the stories' CSS, only a package's,
      // whose version the home's version line names.
      homeCss: ["@acme/ui/ui.css"],
      nav: {
        items: [
          { name: "Site", href: "/" },
          { name: "Fx", href: "https://example.com/fx/" },
          { name: "Other", href: "https://example.com/other/" },
          { name: "Far", href: "//example.com/far/" },
        ],
        current: "Fx",
      },
      head: "./Head.astro",
      copy: ["assets/*.svg", "assets/nested", "@acme/fx/logos/logo.svg"],
      serverOnly: true,
      admin: true,
    }),
  ],
});
