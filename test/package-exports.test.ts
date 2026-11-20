import { expect, test } from "vitest";
import { exported } from "../lib/package-exports.ts";

test("a package can reserve a specific export from its catch-all", () => {
  expect(exported({ "./*": "./dist/*", "./a": null }, "a")).toBe(false);
});

test("a package can reserve a directory of exports from its catch-all", () => {
  expect(exported({ "./*": "./dist/*", "./a/*": null }, "a/a")).toBe(false);
});
