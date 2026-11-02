// The preset as a repository uses it, for the catalog build test.
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
      header: { component: "./Header.astro" },
      head: "./Head.astro",
      copy: ["assets/*.svg", "assets/nested"],
    }),
  ],
});
