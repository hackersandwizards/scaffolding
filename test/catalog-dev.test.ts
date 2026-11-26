import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { CatalogCopies, readCatalogPackage } from "../catalog/copy-assets.ts";
import { CatalogDevAssets, catalogAssetMiddleware, configureCatalogVite } from "../catalog/dev.ts";
import { CatalogMount } from "../catalog/mount.ts";
import { CatalogPageModules } from "../catalog/page-modules.ts";
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
    const mount = new CatalogMount().configureMount(catalogSetupEvent(folder, base));
    const project = { ...readCatalogPackage(folder), require: catalogRequire() };
    configureCatalogVite(
      mount,
      new CatalogPageModules(sampleCatalog, mount, project),
      join(folder, "stories"),
    );
    const update = vi.mocked(mount.params.updateConfig).mock.lastCall?.[0];
    expect(update?.vite?.publicDir).toBe(expected);
  },
);

test.each([{ url: "/old?x=1", target: "/new", expected: "/new?x=1" }])(
  "redirects a legacy URL before a middleware can serve a copied file",
  ({ url, target, expected }) => {
    const mount = new CatalogMount();
    mount.moved = () => target;
    const copies = new CatalogCopies();
    const writeHead = vi.fn<(status: number, headers: Record<string, string>) => void>();
    const next = vi.fn<() => void>();
    const request = { url };
    const response = { writeHead, end: vi.fn<() => void>() };
    type Middleware = (req: typeof request, res: typeof response, next: () => void) => void;
    const use = vi.fn<(middleware: Middleware) => void>();
    const server = { middlewares: { use } } as unknown as Parameters<
      typeof catalogAssetMiddleware
    >[0];
    catalogAssetMiddleware(server, sampleCatalog, { mount, copies });
    use.mock.calls[0]![0](request, response, next);
    expect(writeHead).toHaveBeenCalledWith(307, { Location: expected });
    expect(next).not.toHaveBeenCalled();
  },
);
