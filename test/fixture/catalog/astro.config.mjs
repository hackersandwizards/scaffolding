import { defineConfig } from "astro/config";
import { catalog } from "../../../catalog/index.ts";

export default defineConfig({
  integrations: [
    catalog({
      product: "Fx",
      css: ["./fx.css"],
      lead: "Lead.",
      groupOrder: ["Types", "Parts"],
      previewStates: ["missing", "two"],
      previewSize: { Types: [1440, 900] },
      storyScale: "screen",
      header: { component: "./Header.astro" },
      head: "./Head.astro",
      copy: ["assets/*.svg", "assets/nested", "@acme/fx/logos/logo.svg"],
      serverOnly: true,
      admin: true,
    }),
  ],
});
