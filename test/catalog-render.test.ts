import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import { renderCatalog } from "../catalog/render.ts";
import { rejection } from "../lib/rejection.js";

test("catalog frame loading surfaces an error while assigning the decoded HTML", async () => {
  const rendered = renderCatalog({ title: "Catalog", lead: "", groups: [] });
  const script = rendered.slice(rendered.lastIndexOf("<script>") + 8, -9);
  const browser = {
    loadFrame: (_frame: object): unknown => {
      throw new Error("missing catalog frame loader");
    },
    document: { querySelectorAll: () => [] },
    window: { hwCatalog: true },
    PerformanceObserver: {},
    addEventListener: vi.fn(),
    URL,
    location: { href: "https://catalog.example/" },
    fetch: async () => new Response("<head></head>"),
  };
  runInNewContext(
    script.replace("let started=0;", "globalThis.loadFrame=load;let started=0;"),
    browser,
  );
  const frame = {
    dataset: { src: "/preview" },
    hasAttribute: () => true,
    set srcdoc(_html: string) {
      throw new Error("frame setter failed");
    },
  };
  expect(await rejection(Promise.resolve(browser.loadFrame(frame)))).toBe(
    "Error: frame setter failed",
  );
});

test("catalog srcdoc uses the fetched page URL as the base for relative assets", async () => {
  const rendered = renderCatalog({ title: "Catalog", lead: "", groups: [] });
  const script = rendered.slice(rendered.lastIndexOf("<script>") + 8, -9);
  const url = "https://catalog.example/stories/card/";
  const frame = { dataset: { src: "/preview" }, hasAttribute: () => true, srcdoc: "" };
  const browser = {
    loadFrame: (_frame: typeof frame): Promise<void> => {
      throw new Error("missing catalog frame loader");
    },
    document: { querySelectorAll: () => [] },
    window: { hwCatalog: true },
    PerformanceObserver: {},
    addEventListener: vi.fn(),
    URL,
    location: { href: "https://catalog.example/" },
    fetch: async () => ({
      ok: true,
      url,
      text: async () => '<head><link rel="stylesheet" href="card.css"></head>',
    }),
  };
  runInNewContext(
    script.replace("let started=0;", "globalThis.loadFrame=load;let started=0;"),
    browser,
  );
  await browser.loadFrame(frame);
  expect(frame.srcdoc).toBe(
    `<head><base href="${url}"><link rel="stylesheet" href="card.css"></head>`,
  );
});
