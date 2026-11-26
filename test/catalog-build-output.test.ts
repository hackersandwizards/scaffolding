import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import {
  catalogFileLinks,
  rewriteCatalogOutput,
  writeCatalogForwarders,
} from "../catalog/build-output.ts";
import { testDirectory } from "./test-directory.ts";

test.each([
  { base: "/site", page: "dashboard/a b/index.html", expected: "/site/dashboard/a%20b/" },
])("encodes a forwarding page's path", ({ base, page, expected }) => {
  using fixture = testDirectory();
  const { folder } = fixture;
  mkdirSync(join(folder, "dashboard/a b"), { recursive: true });
  writeFileSync(join(folder, page), "");
  writeCatalogForwarders(folder, base);
  expect(readFileSync(join(folder, "catalog", page), "utf8")).toContain(`href="${expected}"`);
});

test.each([{ html: '<a href="/site/a?q=1#x">', expected: '/a?q=1#x">' }])(
  "prefers an exact file and preserves its query and fragment",
  ({ html, expected }) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    writeFileSync(join(folder, "a"), "");
    writeFileSync(join(folder, "a.html"), "");
    expect(catalogFileLinks(html, folder, "/site")).toBe(
      `<a href="${pathToFileURL(folder).href}${expected}`,
    );
  },
);

test.each([
  {
    html: '<a href="/site/index.html">',
    pattern: "/unregistered",
    expected: '<a href="/site/index.html">',
  },
])("leaves HTML assets belonging to unregistered routes alone", ({ html, pattern, expected }) => {
  using fixture = testDirectory();
  const { folder } = fixture;
  const file = join(folder, "index.html");
  writeFileSync(file, html);
  rewriteCatalogOutput(new Map([[pattern, [pathToFileURL(file)]]]), folder, {
    base: "/site",
    pageRoutes: new Set(),
  });
  expect(readFileSync(file, "utf8")).toBe(expected);
});
