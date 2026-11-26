import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { rejection } from "@hackersandwizards/scaffolding/rejection";
import { CatalogAstroHooks } from "../catalog/index.ts";
import { catalogSetupEvent, sampleCatalog } from "./catalog-fixtures.ts";
import { testDirectory } from "./test-directory.ts";

test.each([
  {
    base: "/site",
    expected: "catalog copy: sample/missing.txt is no file in the exports of sample",
  },
])(
  "reports a copy export failure before reading invalid header options",
  async ({ base, expected }) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    writeFileSync(join(folder, "package.json"), '{"name":"sample","exports":{".":"./index.js"}}');
    const hooks = new CatalogAstroHooks({
      ...sampleCatalog,
      htmlClass: ["invalid class"],
      copy: ["sample/missing.txt"],
    });
    expect(await rejection(hooks.configureCatalog(catalogSetupEvent(folder, base)))).toContain(
      expected,
    );
  },
);

test.each([{ pattern: "/page", expected: ["/page"] }])(
  "replaces old page patterns and ignores non-page routes",
  ({ pattern, expected }) => {
    const hooks = new CatalogAstroHooks(sampleCatalog);
    hooks.mount.pageRoutes.add("/old");
    const routes = [
      { type: "page", pattern },
      { type: "endpoint", pattern: "/api" },
    ];
    hooks.catalogRoutes({ routes } as unknown as Parameters<typeof hooks.catalogRoutes>[0]);
    expect([...hooks.mount.pageRoutes]).toEqual(expected);
  },
);

test.each([{ copy: ["assets/**/*.txt"], expected: 1 }])(
  "registers a single copy middleware for the dev server",
  ({ copy, expected }) => {
    const hooks = new CatalogAstroHooks({ ...sampleCatalog, copy });
    const use = vi.fn();
    hooks.catalogServer({ server: { middlewares: { use } } } as unknown as Parameters<
      typeof hooks.catalogServer
    >[0]);
    expect(use).toHaveBeenCalledTimes(expected);
  },
);

test.each([{ base: "/site", expected: "/site/" }])(
  "writes forwarding pages before failing on a missing copy",
  ({ base, expected }) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    const hooks = new CatalogAstroHooks({ ...sampleCatalog, copy: ["missing.txt"] });
    hooks.mount.base = base;
    hooks.mount.forwards = true;
    writeFileSync(join(folder, "index.html"), "");
    const event = { dir: pathToFileURL(folder), assets: new Map() };
    expect(() =>
      hooks.finishCatalogBuild(event as unknown as Parameters<typeof hooks.finishCatalogBuild>[0]),
    ).toThrow("matches nothing");
    expect(existsSync(join(folder, "catalog/index.html"))).toBe(true);
    expect(readFileSync(join(folder, "catalog/index.html"), "utf8")).toContain(
      `href="${expected}"`,
    );
  },
);

test.each([{ expected: new Error("nested server error") }])(
  "preserves a nested server hook rejection",
  async ({ expected }) => {
    const hooks = new CatalogAstroHooks(sampleCatalog);
    hooks.inner = {
      name: "test server",
      hooks: { "astro:server:start": vi.fn().mockRejectedValue(expected) },
    };
    const result = await hooks
      .startCatalogServer({} as Parameters<typeof hooks.startCatalogServer>[0])
      .catch((error: unknown) => error);
    expect(result).toBe(expected);
  },
);
