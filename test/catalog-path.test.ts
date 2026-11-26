import { expect, test } from "vitest";
import { decodeCatalogPath } from "../catalog/path.ts";

test.each([{ path: "/catalog/%invalid", expected: "" }])(
  "leaves malformed URL escapes without a decoded catalog path",
  ({ path, expected }) => expect(decodeCatalogPath(path)).toBe(expected),
);
