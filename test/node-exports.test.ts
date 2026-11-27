import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { pathWithoutBunNode } from "./bun-node.ts";
import { testDirectory } from "./test-directory.ts";

const { name, exports } = JSON.parse(readFileSync("package.json", "utf8")) as {
  name: string;
  exports: Record<string, string>;
};

test.each([
  ["defined", "defined"],
  ["rejection", "rejection"],
  ["test-timeout", "limit"],
])("Node imports ./%s from a consumer's node_modules", (subpath, names) => {
  using consumer = testDirectory();
  const installed = join(consumer.folder, "node_modules", name);
  const target = exports[`./${subpath}`];
  mkdirSync(dirname(join(installed, target)), { recursive: true });
  cpSync("package.json", join(installed, "package.json"));
  cpSync(target, join(installed, target));
  const script = `import("${name}/${subpath}").then((m) => console.log(process.versions.bun ?? "node", Object.keys(m).join()))`;
  const loaded = execFileSync("node", ["-e", script], {
    cwd: consumer.folder,
    encoding: "utf8",
    env: { ...process.env, PATH: pathWithoutBunNode() },
  });
  expect(loaded.trim()).toBe(`node ${names}`);
});
