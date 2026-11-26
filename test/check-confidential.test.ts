import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { inputTestRepo, runInputCheck } from "./preloaded-check.ts";
import { testDirectory } from "./test-directory.ts";

function writeInputTestTerms(folder: string) {
  writeFileSync(
    join(folder, "terms.json"),
    JSON.stringify({
      built: new Date().toISOString(),
      salt: "fixture",
      maxTokens: 1,
      hashes: [],
      never: ["placeholder-hash"],
    }),
  );
}

test("the never scan propagates unexpected stdin parser failures", () => {
  using fixture = testDirectory();
  inputTestRepo(fixture.folder);
  writeInputTestTerms(fixture.folder);
  const value = '{"deck":"example text"}';
  const run = runInputCheck(
    fixture.folder,
    ["check-confidential", "never", "--list", "terms.json"],
    `
const parse = JSON.parse;
JSON.parse = (text, reviver) => {
  if (text === ${JSON.stringify(value)}) throw new Error("stdin parsing failed");
  return parse(text, reviver);
};
`,
  );
  expect(run(value).stderr).toMatch(/^error: stdin parsing failed$/m);
});

test("the confidential scan propagates unexpected ZIP parser failures", () => {
  using fixture = testDirectory();
  inputTestRepo(fixture.folder);
  writeInputTestTerms(fixture.folder);
  const zip = Buffer.alloc(26);
  zip.writeUInt32LE(0x04034b50, 0);
  zip.writeUInt32LE(0x06054b50, 4);
  writeFileSync(join(fixture.folder, "example.zip"), zip);
  execFileSync("git", ["add", "--", "example.zip"], { cwd: fixture.folder });
  const run = runInputCheck(
    fixture.folder,
    ["check-confidential", "--index", "--list", "terms.json"],
    `
const readUInt32LE = Buffer.prototype.readUInt32LE;
Buffer.prototype.readUInt32LE = function (at) {
  if (at === 20 && this.length === 26) throw new Error("ZIP parsing failed");
  return readUInt32LE.call(this, at);
};
`,
  );
  expect(run().stderr).toMatch(/^error: ZIP parsing failed$/m);
});
