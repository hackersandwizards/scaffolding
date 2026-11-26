import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
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

let savedGitEnv: [string, string | undefined][] = [];

function clearGitEnv(): void {
  savedGitEnv = Object.entries(process.env).filter(([key]) => key.startsWith("GIT_"));
  for (const [key] of savedGitEnv) delete process.env[key];
}

function restoreGitEnv(): void {
  for (const [key, value] of savedGitEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedGitEnv = [];
}

beforeEach(clearGitEnv);
afterEach(restoreGitEnv);

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

const CHECK_CONFIDENTIAL_BIN = fileURLToPath(
  new URL("../bin/check-confidential.ts", import.meta.url),
);

function runCheckConfidential(cwd: string, args: string[], pathPrefix?: string) {
  const env = cleanGitEnv();
  delete env.CI;
  delete env.SCAFFOLDING_CONFIDENTIAL_TERMS;
  if (pathPrefix) env.PATH = `${pathPrefix}:${env.PATH ?? ""}`;
  return spawnSync("bun", ["--no-env-file", CHECK_CONFIDENTIAL_BIN, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

test("check-confidential never --staged reports path wording and honours file names allow", () => {
  const dir = initTempRepo("conf-never-staged-");
  try {
    const salt = "never-staged-salt";
    const listFile = join(dir, "terms.json");
    writeFileSync(
      listFile,
      JSON.stringify({
        built: new Date().toISOString(),
        salt,
        maxTokens: 1,
        hashes: [],
        never: [createTermHasher(salt)("any:zetacorp")],
      }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
    writeFileSync(join(dir, "zetacorp-notes.txt"), "plain text\n");
    runGit(dir, ["add", "package.json", "zetacorp-notes.txt"]);

    const refused = runCheckConfidential(dir, ["never", "--staged", "--list", listFile]);
    expect(refused.status).toBe(1);
    expect(`${refused.stdout}${refused.stderr}`).toContain(
      "a name h&w never shows from the company records in the file's path: rename the file to a generic or fictitious name.",
    );

    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "demo",
        scaffolding: {
          allow: [
            {
              check: "never-shown",
              path: "file names",
              text: "zetacorp",
              reason: "test file-name allow",
            },
          ],
        },
      }),
    );
    runGit(dir, ["add", "package.json"]);
    const allowed = runCheckConfidential(dir, ["never", "--staged", "--list", listFile]);
    expect(allowed.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-confidential never --staged --list-optional warns without fetching after a recent attempt", () => {
  const dir = initTempRepo("conf-never-opt-cli-");
  try {
    const cacheDir = join(dir, "node_modules/.cache/scaffolding");
    const fakeBin = join(dir, "fake-bin");
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(cacheDir, "confidential-terms.json.attempt"), "");
    writeFileSync(join(fakeBin, "gh"), '#!/bin/sh\necho "FAKE_GH_CALLED" >&2\nexit 1\n', {
      mode: 0o755,
    });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
    writeFileSync(join(dir, "hello.txt"), "plain text\n");
    runGit(dir, ["add", "package.json", "hello.txt"]);

    const run = runCheckConfidential(dir, ["never", "--staged", "--list-optional"], fakeBin);
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("no copy; next fetch within the hour");
    expect(run.stderr).toContain("--list-optional: terms not scanned");
    expect(run.stderr).not.toContain("FAKE_GH_CALLED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
