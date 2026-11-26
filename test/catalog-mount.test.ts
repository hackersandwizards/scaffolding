import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  CatalogMount,
  catalogForwardLink,
  catalogRedirects,
  catalogUsesFileUrls,
} from "../catalog/mount.ts";
import { catalogSetupEvent } from "./catalog-fixtures.ts";
import { testDirectory } from "./test-directory.ts";

test.each([{ base: "/x", source: { css: "file:///site", fallback: "/x" }, expected: true }])(
  "recognises a file URL among type-specific prefixes",
  ({ base, source, expected }) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    const { config } = catalogSetupEvent(folder, base);
    config.build.assetsPrefix = source;
    expect(catalogUsesFileUrls(config, false)).toBe(expected);
  },
);

test.each([{ base: "/x", home: "/x/", page: "catalog.ts", expected: "/x/" }])(
  "leaves the catalog link at home when a file already owns its legacy path",
  ({ base, home, page, expected }) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    writeFileSync(join(folder, page), "");
    expect(catalogForwardLink(base, home, folder)).toBe(expected);
  },
);

test.each([{ input: "/x//stories/a", expected: "/stories/a" }])(
  "collapses the leading double slash after dropping the old base",
  ({ input, expected }) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    const mount = new CatalogMount();
    mount.atRoot = true;
    mount.root = folder;
    mount.publicDir = folder;
    mount.dev = true;
    mount.pagesBase = "/x";
    const redirect = catalogRedirects(mount);
    expect(redirect(input)).toBe(expected);
  },
);

test.each([{ base: "/parent/catalog/", expected: "/parent/catalog/" }])(
  "keeps a mounted catalog link under the host's base",
  ({ base, expected }) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    const mount = new CatalogMount();
    mount.configureMount(catalogSetupEvent(folder, base));
    expect(mount.link).toBe(expected);
  },
);

test.each([{ base: "/published", expected: "/" }])(
  "returns Astro's rebased dev event and records the published base on the mount",
  ({ base, expected }) => {
    using fixture = testDirectory();
    const event = catalogSetupEvent(fixture.folder, base);
    event.command = "dev";
    event.updateConfig = () => ({ ...event.config, base: expected });
    const mount = new CatalogMount();
    const params = mount.configureMount(event);
    expect(params.config.base).toBe(expected);
    expect(mount.pagesBase).toBe(base);
  },
);
