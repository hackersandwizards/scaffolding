import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { readHolder as readHookHolder } from "../.githooks/check-lock-record.ts";
import { readHolder as readTemplateHolder } from "../template/.githooks/check-lock-record.ts";
import { parseTermList } from "../lib/confidential-input.ts";
import { licenceAllowed } from "../lib/licence-expression.ts";
import { parseLicenseCommandOutput } from "../lib/license-audit.ts";
import { rejection } from "../lib/rejection.ts";
import { testDirectory } from "./test-directory.ts";

function failParsingInput(input: string, failure: Error) {
  const parse = JSON.parse;
  return vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (text === input) throw failure;
    return parse(text, reviver) as unknown;
  });
}

test.each([
  ["hook", readHookHolder],
  ["template", readTemplateHolder],
] as const)("the %s holder parser propagates unexpected parser failures", (_copy, read) => {
  using fixture = testDirectory();
  const path = join(fixture.folder, "check.lock");
  const value = '{"pid":109,"startedAt":2}';
  writeFileSync(path, value);
  const failure = new RangeError("holder parser failed");
  using _parse = failParsingInput(value, failure);
  expect(() => read(path)).toThrow(failure);
});

test("term-list parsing propagates unexpected parser failures", () => {
  const value = '{"salt":"fixture"}';
  const failure = new RangeError("term-list parser failed");
  using _parse = failParsingInput(value, failure);
  expect(() => parseTermList(value)).toThrow(failure);
});

function failLicenceLookup(failure: Error) {
  const has = Set.prototype.has;
  return vi.spyOn(Set.prototype, "has").mockImplementation(function (this: Set<unknown>, key) {
    if (key === "MIT") throw failure;
    return has.call(this, key);
  });
}

test("licence expressions propagate unexpected allow-set failures", () => {
  const failure = new RangeError("licence lookup failed");
  using _find = failLicenceLookup(failure);
  expect(() => licenceAllowed("MIT")).toThrow(failure);
});

test("licence expressions reject deeply nested unclosed groups", () => {
  const expression = "(".repeat(100_000) + "MIT";
  expect(licenceAllowed(expression)).toBe(false);
});

test("licence command output propagates unexpected parser failures", () => {
  const stdout = '{"MIT":[{"name":"example","license":"MIT"}]}';
  const failure = new RangeError("licence output parser failed");
  using _parse = failParsingInput(stdout, failure);
  expect(() => parseLicenseCommandOutput({ status: 0, stdout, stderr: "" }, () => [])).toThrow(
    failure,
  );
});

test("rejection propagates an unexpected serialization failure", async () => {
  const value = {
    toJSON() {
      throw new RangeError("serializer failed");
    },
  };
  expect(await rejection(rejection(Promise.resolve(value)))).toBe("RangeError: serializer failed");
});

function runInputCheck(folder: string, command: string[], preload: string) {
  const hook = join(folder, "preload.ts");
  writeFileSync(hook, preload);
  const [name, ...args] = command;
  return (input?: string) =>
    spawnSync(
      process.execPath,
      [
        "--no-env-file",
        "--preload",
        hook,
        join(import.meta.dirname, "..", "bin", `${name}.ts`),
        ...args,
      ],
      { cwd: folder, encoding: "utf8", input, env: { ...process.env, CI: "" } },
    );
}

function inputTestRepo(folder: string) {
  execFileSync("git", ["init", "-q", "--template="], { cwd: folder });
}

test("check-licenses lets an unexpected lockfile read error surface", () => {
  using fixture = testDirectory();
  inputTestRepo(fixture.folder);
  mkdirSync(join(fixture.folder, "bun.lock"));
  const run = runInputCheck(
    fixture.folder,
    ["check-licenses"],
    `
import * as cp from "node:child_process";
import { mock } from "bun:test";
const { spawnSync } = cp;
mock.module("node:child_process", () => ({
  ...cp,
  spawnSync(command, args, options) {
    if (args.includes("licenses"))
      return { status: 0, stdout: '{"MIT":[{"name":"example","license":"MIT"}]}', stderr: "example not installed" };
    return spawnSync(command, args, options);
  },
}));
`,
  );
  expect(run().stderr).toMatch(/^EISDIR:/m);
});

test("check-coupling propagates unexpected package-text parser failures", () => {
  using fixture = testDirectory();
  inputTestRepo(fixture.folder);
  const value = '{"name":"input-fixture"}';
  writeFileSync(join(fixture.folder, "package.json"), value);
  const run = runInputCheck(
    fixture.folder,
    ["check-coupling"],
    `
const parse = JSON.parse;
let examined = 0;
JSON.parse = (text, reviver) => {
  if (text === ${JSON.stringify(value)} && ++examined === 3)
    throw new Error("package text parsing failed");
  return parse(text, reviver);
};
`,
  );
  expect(run().stderr).toMatch(/^error: package text parsing failed$/m);
});

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
