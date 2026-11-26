import { expect, test, vi } from "vitest";
import { decodeCatalogPath } from "../catalog/path.ts";

test.each([{ path: "/catalog/%invalid", expected: "" }])(
  "leaves malformed URL escapes without a decoded catalog path",
  ({ path, expected }) => expect(decodeCatalogPath(path)).toBe(expected),
);

test("catalog path decoding surfaces an unexpected decoder error", () => {
  const error = new Error("decoder bug");
  using decoder = vi.spyOn(globalThis, "decodeURIComponent").mockImplementationOnce(() => {
    throw error;
  });
  expect(() => decodeCatalogPath("/catalog/example")).toThrow(error);
  expect(decoder).toHaveBeenCalledWith("/catalog/example");
});
