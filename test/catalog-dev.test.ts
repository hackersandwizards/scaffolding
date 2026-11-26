import { expect, test, vi } from "vitest";
import { CatalogCopies, readCatalogPackage } from "../catalog/copy-assets.ts";
import { CatalogDevAssets, catalogAssetMiddleware, configureCatalogVite } from "../catalog/dev.ts";
import { CatalogAstroHooks } from "../catalog/hooks.ts";
import { CatalogMount } from "../catalog/mount.ts";
import { CatalogPageModules } from "../catalog/page-modules.ts";
import { defined } from "../lib/defined.ts";
import { catalogRequire, catalogSetupEvent, sampleCatalog } from "./catalog-fixtures.ts";
import { testDirectory } from "./test-directory.ts";

test.each([{ path: "/site2/a", base: "/site", expected: false }])(
  "requires a whole base path segment",
  ({ path, base, expected }) => {
    const mount = new CatalogMount();
    mount.base = base;
    const copies = new CatalogCopies();
    copies.servePath = vi.fn();
    const assets = new CatalogDevAssets(mount, copies, ["a"]);
    const res = {} as Parameters<typeof assets.respond>[1];
    expect(assets.respond(path, res)).toBe(expected);
    expect(copies.servePath).not.toHaveBeenCalled();
  },
);

test.each([{ base: "/parent/catalog", expected: false }])(
  "leaves static public files to the host for a mounted build",
  ({ base, expected }) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    const mount = new CatalogMount();
    const params = mount.configureMount(catalogSetupEvent(folder, base));
    const project = { ...readCatalogPackage(folder), require: catalogRequire() };
    configureCatalogVite(params, mount, new CatalogPageModules(sampleCatalog, mount, project));
    const update = defined(vi.mocked(params.updateConfig).mock.lastCall, "updateConfig call")[0];
    expect(defined(update.vite, "vite config").publicDir).toBe(expected);
  },
);

test.each([
  { url: "/old?x=1", target: "/new", expected: "/new?x=1" },
  { url: "http://[", target: "/new", expected: "/new" },
])(
  "redirects a legacy URL before a middleware can serve a copied file ($url)",
  ({ url, target, expected }) => {
    const site = new CatalogAstroHooks(sampleCatalog);
    site.mount.moved = () => target;
    const writeHead = vi.fn<(status: number, headers: Record<string, string>) => void>();
    const next = vi.fn<() => void>();
    const request = { url };
    const response = { writeHead, end: vi.fn<() => void>() };
    type Middleware = (req: typeof request, res: typeof response, next: () => void) => void;
    const use = vi.fn<(middleware: Middleware) => void>();
    const server = { middlewares: { use } } as unknown as Parameters<
      typeof catalogAssetMiddleware
    >[0];
    catalogAssetMiddleware(server, [], site);
    defined(use.mock.calls[0], "registered catalog middleware call")[0](request, response, next);
    expect(writeHead).toHaveBeenCalledWith(307, { Location: expected });
    expect(next).not.toHaveBeenCalled();
  },
);

test.each([
  { pattern: "assets/*.svg", url: "/assets/logo.svg", expected: [["assets/*.svg", "assets"]] },
])("uses the copy patterns supplied to the middleware", ({ pattern, url, expected }) => {
  const site = new CatalogAstroHooks(sampleCatalog);
  site.copies.servePath = vi.fn();
  const next = vi.fn<() => void>();
  type Middleware = (req: { url: string }, res: object, next: () => void) => void;
  const use = vi.fn<(middleware: Middleware) => void>();
  const server = { middlewares: { use } } as unknown as Parameters<
    typeof catalogAssetMiddleware
  >[0];
  catalogAssetMiddleware(server, [pattern], site);
  defined(use.mock.calls[0], "registered catalog middleware call")[0]({ url }, {}, next);
  expect(site.copies.servePath).toHaveBeenCalledWith("assets/logo.svg", expected);
  expect(next).toHaveBeenCalledTimes(1);
});
