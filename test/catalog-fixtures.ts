import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";
import type { CatalogSetupEvent } from "../catalog/mount.ts";

export function catalogSetupEvent(root: string, base: string) {
  mkdirSync(join(root, "src", "pages"), { recursive: true });
  const config = {
    root: pathToFileURL(`${root}/`),
    publicDir: pathToFileURL(join(root, "public")),
    srcDir: pathToFileURL(join(root, "src")),
    outDir: pathToFileURL(join(root, "dist/")),
    base,
    build: { format: "directory", assetsPrefix: undefined },
    redirects: {},
    trailingSlash: "ignore",
  } as CatalogSetupEvent["config"];
  return {
    command: "build",
    config,
    createCodegenDir: () => pathToFileURL(join(root, "codegen")),
    updateConfig: vi.fn(() => config),
  } as unknown as CatalogSetupEvent;
}

export const sampleCatalog = { product: "Sample", lead: "", css: [] };

export function catalogRequire() {
  const unavailable = () => {
    throw Object.assign(new Error("fixture package unavailable"), { code: "MODULE_NOT_FOUND" });
  };
  return Object.assign(vi.fn(unavailable), {
    resolve: vi.fn(unavailable),
  }) as unknown as ReturnType<typeof import("node:module").createRequire>;
}
