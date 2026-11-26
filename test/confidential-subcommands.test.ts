import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  buildPurgedListJson,
  buildTermListJson,
  cliFlagValue,
  evaluatePrepush,
  hasLfsTrackedChanges,
  lfsObjectDirs,
  parsePurgedHashEntry,
  readExistingPurgedList,
  validateNeverBuildNames,
} from "../lib/confidential-subcommands.ts";
import { createTermHasher } from "../lib/confidential-terms.ts";
import { defined } from "../lib/defined.ts";

function cleanGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

function runGit(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, env: cleanGitEnv(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function initTempRepo(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  runGit(dir, ["init", "-q", "-b", "main"]);
  runGit(dir, ["config", "user.name", "Test"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  return dir;
}

test.each([
  { argv: ["--list", "a.json", "--staged"], flag: "--list", expected: "a.json" },
  { argv: ["--staged"], flag: "--list", expected: undefined },
])("cliFlagValue($flag)", ({ argv, flag, expected }) => {
  expect(cliFlagValue(argv, flag)).toBe(expected);
});

test("validateNeverBuildNames accepts valid names", () => {
  expect(validateNeverBuildNames(["Zetacorp GmbH"])).toBeUndefined();
});

test.each([
  { label: "empty", names: [], expected: "no name" },
  { label: "short", names: ["AB GmbH"], expected: "under three letters: AB GmbH" },
])("validateNeverBuildNames rejects $label", ({ names, expected }) => {
  expect(validateNeverBuildNames(names)).toContain(expected);
});

test("parsePurgedHashEntry handles empty, valid, and malformed lists", () => {
  expect(parsePurgedHashEntry("   ", "checkout")).toEqual({});
  const valid = parsePurgedHashEntry(JSON.stringify({ salt: "s", hashes: ["h1"] }), "checkout");
  expect(valid.entry?.bad.has("h1")).toBe(true);
  expect(valid.finding).toBeUndefined();

  const bad = parsePurgedHashEntry("{bad", "checkout");
  expect(bad.finding?.message).toBe("checkout does not parse: repair it, then push");
});

test("buildTermListJson builds hashed terms and never hashes", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-build-"));
  try {
    const dict = join(dir, "words");
    writeFileSync(dict, "apple\n");
    const built = buildTermListJson(["build", "-", "--never", "-"], "Xylophon\0QUUX", dict);
    expect(built.exitCode).toBe(0);
    const parsed = JSON.parse(defined(built.stdout, "buildTermListJson stdout")) as {
      hashes: string[];
      never: string[];
      maxTokens: number;
    };
    expect(parsed.maxTokens).toBe(1);
    expect(parsed.hashes).toHaveLength(1);
    expect(parsed.never).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTermListJson rejects a missing dictionary file", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-build-nodict-"));
  try {
    const noDict = buildTermListJson(["build", "-"], "Xylophon", join(dir, "missing-words"));
    expect(noDict.exitCode).toBe(1);
    expect(noDict.stderr).toContain("missing-words");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readExistingPurgedList and buildPurgedListJson fall back to index and reject malformed lists", () => {
  const dir = initTempRepo("conf-purged-");
  try {
    const initial = JSON.stringify({ salt: "fixed-salt", hashes: ["existing"] });
    writeFileSync(join(dir, ".confidential-purged.json"), initial);
    runGit(dir, ["add", ".confidential-purged.json"]);
    runGit(dir, ["commit", "-q", "-m", "add purged"]);
    writeFileSync(join(dir, ".confidential-purged.json"), "");

    expect(readExistingPurgedList(dir)).toEqual({
      list: { salt: "fixed-salt", hashes: ["existing"] },
      malformed: false,
    });
    const built = buildPurgedListJson(dir, ["deadbeef"]);
    expect(built.exitCode).toBe(0);
    expect(JSON.parse(defined(built.stdout, "buildPurgedListJson stdout"))).toEqual({
      salt: "fixed-salt",
      hashes: ["existing", createTermHasher("fixed-salt")("deadbeef")].sort(),
    });

    writeFileSync(join(dir, ".confidential-purged.json"), "{broken");
    runGit(dir, ["add", ".confidential-purged.json"]);
    expect(buildPurgedListJson(dir, ["deadbeef"]).exitCode).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lfsObjectDirs includes default lfs/objects and configured lfs.storage", () => {
  const dir = initTempRepo("conf-lfs-dirs-");
  try {
    expect(lfsObjectDirs(dir)).toEqual([join(dir, ".git", "lfs/objects")]);
    runGit(dir, ["config", "lfs.storage", join(dir, "custom-lfs")]);
    expect(lfsObjectDirs(dir)).toEqual([
      join(dir, ".git", "lfs/objects"),
      join(dir, "custom-lfs", "objects"),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasLfsTrackedChanges and evaluatePrepush detect lockable attributes and purged commits", () => {
  const dir = initTempRepo("conf-prepush-");
  try {
    writeFileSync(join(dir, "note.txt"), "hello\n");
    runGit(dir, ["add", "note.txt"]);
    runGit(dir, ["commit", "-q", "-m", "initial"]);
    const first = runGit(dir, ["rev-parse", "HEAD"]);
    expect(
      hasLfsTrackedChanges(dir, first, ["--ignore-missing", "--not", "--remotes=origin"]),
    ).toBe(false);

    writeFileSync(join(dir, ".gitattributes"), "*.bin lockable\n");
    writeFileSync(join(dir, "asset.bin"), "data\n");
    runGit(dir, ["add", ".gitattributes", "asset.bin"]);
    runGit(dir, ["commit", "-q", "-m", "lockable"]);
    const second = runGit(dir, ["rev-parse", "HEAD"]);
    expect(hasLfsTrackedChanges(dir, second, ["--ignore-missing", "--not", first])).toBe(true);

    const salt = "prepush-salt";
    writeFileSync(
      join(dir, ".confidential-purged.json"),
      JSON.stringify({ salt, hashes: [createTermHasher(salt)(second)] }),
    );
    const result = evaluatePrepush(
      ["prepush", "origin"],
      dir,
      `refs/heads/main ${second} refs/heads/main ${first}\n`,
    );
    expect(result.invokeLfs).toBe(false);
    expect(result.findings.map((finding) => finding.text)).toEqual([second]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
