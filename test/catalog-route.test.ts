import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { astrobookRouteKind, readRouteUntilRewritten, rewriteRoute } from "../catalog/route.ts";
import { testDirectory } from "./test-directory.ts";

const source = [
  "import { parseStoryNamedExport } from 'astrobook/client';",
  "const { args } = parseStoryNamedExport(m, 'a', 'One');",
  "",
].join("\n");

test.each([{ file: "dashboard\\nested\\a.astro", source, expected: "dashboard" }])(
  "recognizes a nested dashboard from a Windows path",
  ({ file, source, expected }) => {
    expect(() => astrobookRouteKind(file, source)).not.toThrow();
    expect(astrobookRouteKind(file, source)).toBe(expected);
  },
);

test.each([
  { file: "dashboard/a.astro", source, expected: "has no sidebar for the bar to replace" },
])(
  "reports the missing sidebar before the missing hydration branch",
  ({ file, source, expected }) => {
    expect(() => rewriteRoute(file, source, true)).toThrow(expected);
  },
);

test.each([
  {
    source: "  Astrobook already rewrote this route\n",
    expected: "  Astrobook already rewrote this route\n",
  },
])("returns the exact text when a rewrite is unnecessary", async ({ source, expected }) => {
  using fixture = testDirectory();
  const file = join(fixture.folder, "route.astro");
  writeFileSync(file, source);
  expect(await readRouteUntilRewritten(file, () => undefined, 0)).toBe(expected);
});
