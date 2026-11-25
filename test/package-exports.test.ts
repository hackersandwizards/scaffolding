import { expect, test } from "vitest";
import { exported, targeted } from "../lib/package-exports.ts";

test("a package can reserve a specific export from its catch-all", () => {
  expect(exported({ "./*": "./dist/*", "./a": null }, "a")).toBe(false);
});

test("a package can reserve a directory of exports from its catch-all", () => {
  expect(exported({ "./*": "./dist/*", "./a/*": null }, "a/a")).toBe(false);
});

test.each([
  [undefined, "pkg/deep", true],
  [null, "pkg/deep", true],
  ["./index.js", "pkg/deep", false],
  [["./index.js"], "pkg/deep", false],
  [{ import: "./index.js" }, "pkg/deep", false],
  [{ "": "./index.js" }, "", false],
  [{ "lib/": "./lib/" }, "lib/file.js", false],
  [{ "./lib/": "./lib/", "./unused": null }, "lib/file.js", true],
  [{ "./lib/": null }, "lib/file.js", false],
  [{ "./lib": "./lib" }, "lib/file.js", false],
  [{ "./lib/": "./lib/" }, "unrelated/lib/", false],
  [{ "./lib/*": "./lib/*" }, "lib/", false],
  [{ "./lib/**": "./lib/*" }, "lib/abc", false],
  [{ "./a": "./dist/a.js" }, "a", true],
  [{ "x*": "./wrong/*", "./a": null }, "xx", false],
  [{ "*": "./wrong/*", "./a": null }, "xx", false],
  [{ "./a**": "./dist/*", "./*": null }, "a**", false],
  [{ "./lib*/": "./lib/" }, "lib/file.js", false],
  [{ "./*": "./dist/*", "./a": null }, "a/x", true],
  [{ "./*": null, "./a/*.js": "./dist/*.js" }, "a/x.js", true],
  [{ "./a/*": "./dist/*", "./a/*.js": null }, "a/x.js", false],
  [{ "./a/*.js": null, "./a/*": "./dist/*" }, "a/x.js", false],
  [{ "./a/*.js": "./dist/*", "./a/x*": null }, "a/xy.js", false],
  [{ "./a/*.js": null, "./a/x*": "./dist/*" }, "a/xy.js", true],
  [{ "./a/*": null, "./a/": "./lib/" }, "a/x.js", false],
  [{ "./*": "./dist/*", "./a*": null }, "a*", false],
])("classifies export map %j for %s", (value, path, expected) => {
  expect(exported(value, path)).toBe(expected);
});

test.each([
  ["dist/a.js", true],
  ["dist/a.cjs", true],
  ["dist/b.js", false],
  ["dist/p.js", true],
  ["dist/.js", false],
  ["dist/p", false],
  ["dist/bc.js", false],
] as const)(
  "matches normalized conditional and wildcard export targets for %s",
  (path, expected) => {
    const value = {
      "./a": { import: "./dist/./a.js", require: "./dist/a.cjs" },
      "./x": "./dist/p*.js",
      "./overlap": "./dist/bc*bc.js",
    };
    expect(targeted(value, path)).toBe(expected);
  },
);
