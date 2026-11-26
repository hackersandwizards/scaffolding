import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  directoryHoldsFile,
  findPurgedCommitFindings,
  hasLfsOrLockableAttr,
  parseCatFileBatch,
  parseIndexEntries,
  parseNumstatEntries,
  parsePrepushRefs,
  parseTreeEntries,
} from "../lib/confidential-git.ts";

test("parsePrepushRefs handles source expressions with spaces and skips zero SHAs", () => {
  const input = [
    "main@{2026-01-01 10:00} 1111111 refs/heads/main 2222222",
    "(delete) 0000000000000000000000000000000000000000 refs/heads/old 3333333",
    "refs/heads/new 4444444 refs/heads/new 0000000000000000000000000000000000000000",
  ].join("\n");
  expect(parsePrepushRefs(input)).toEqual({
    locals: ["1111111", "4444444"],
    remoteTips: ["2222222", "3333333"],
  });
});

test("parseNumstatEntries detects binary markers and preserves paths", () => {
  const raw = "10\t2\tsrc/app.ts\0-\t-\tassets/logo.png\0";
  expect(parseNumstatEntries(raw)).toEqual([
    { binary: false, path: "src/app.ts" },
    { binary: true, path: "assets/logo.png" },
  ]);
});

test("parseCatFileBatch reads blobs sequentially and throws on non-blob entries", () => {
  const batch = Buffer.from("aaa blob 5\nhello\nbbb blob 3\nbye\n");
  expect(parseCatFileBatch(batch, ["a.txt", "b.txt"])).toEqual([
    Buffer.from("hello"),
    Buffer.from("bye"),
  ]);
  expect(() => parseCatFileBatch(Buffer.from("ccc missing\n"), ["c.txt"])).toThrow(
    "git cat-file: c.txt not readable (missing)",
  );
});

test("parseTreeEntries parses ls-tree -z records", () => {
  const raw = ["100644 blob abc123\tsrc/a.ts", "160000 commit def456\tsub", ""].join("\0");
  expect(parseTreeEntries(raw)).toEqual([
    { type: "blob", sha: "abc123", path: "src/a.ts" },
    { type: "commit", sha: "def456", path: "sub" },
  ]);
});

test("parseIndexEntries parses stage-0 entries and stops at the first unmerged path", () => {
  const clean = ["100644 abc123 0\tsrc/a.ts", "160000 def456 0\tsub", ""].join("\0");
  expect(parseIndexEntries(clean)).toEqual({
    entries: [
      { type: "blob", sha: "abc123", path: "src/a.ts" },
      { type: "commit", sha: "def456", path: "sub" },
    ],
  });
  const unmerged = ["100644 abc123 0\tsrc/a.ts", "100644 bbb222 1\tsrc/conflict.ts", ""].join("\0");
  expect(parseIndexEntries(unmerged)).toEqual({
    entries: [{ type: "blob", sha: "abc123", path: "src/a.ts" }],
    unmergedPath: "src/conflict.ts",
  });
});

test.each([
  { output: "a.bin\0filter\0lfs\0", expected: true },
  { output: "a.bin\0lockable\0set\0", expected: true },
  { output: "a.txt\0filter\0unspecified\0a.txt\0lockable\0unspecified\0", expected: false },
])("hasLfsOrLockableAttr($output) is $expected", ({ output, expected }) => {
  expect(hasLfsOrLockableAttr(output)).toBe(expected);
});

test("directoryHoldsFile returns true only when a nested file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "holds-file-"));
  try {
    mkdirSync(join(dir, "empty/nested"), { recursive: true });
    expect(directoryHoldsFile(join(dir, "missing"))).toBe(false);
    expect(directoryHoldsFile(join(dir, "empty"))).toBe(false);
    writeFileSync(join(dir, "empty/nested/obj"), "x");
    expect(directoryHoldsFile(join(dir, "empty"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findPurgedCommitFindings flags matching commits across purged lists", () => {
  const lists = [{ bad: new Set(["h:bad1"]), hash: (sha: string) => `h:${sha}` }];
  expect(findPurgedCommitFindings(["good1", "bad1"], lists)).toEqual([
    {
      check: "confidential",
      path: "push",
      text: "bad1",
      message:
        "commit purged from this repository's history: clone again and carry your own work over by hand",
    },
  ]);
});
