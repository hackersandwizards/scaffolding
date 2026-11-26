import { expect, test } from "vitest";
import * as entry from "../catalog/index.ts";

test.each([{ api: entry, expected: ["catalog", "renderCatalog"] }])(
  "publishes the catalog preset and renderer from its package entry",
  ({ api, expected }) => {
    expect(Object.keys(api).sort()).toEqual(expected);
  },
);
