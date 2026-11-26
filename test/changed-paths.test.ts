import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  collectRangeChanges,
  collectRangeChangesWithShell,
  collectWorkingTreeChanges,
  collectWorkingTreeChangesWithShell,
  parseNulPaths,
  readShellTreeInputs,
  readWorkingTreeShellInputs,
  resolveRangePaths,
  verifyCommitRange,
} from "../lib/changed-paths.ts";
import { installCleanGitEnvHooks } from "./git-env.ts";

installCleanGitEnvHooks();

function runGit(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, env: process.env, encoding: "utf8" });
  return res.stdout.trim();
}

function withTempGitRepo(run: (dir: string, firstSha: string, secondSha: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "changed-paths-test-"));
  try {
    runGit(dir, ["init", "-q"]);
    runGit(dir, ["config", "user.email", "test@example.com"]);
    runGit(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "base.sh"), "#!/bin/sh\nsource ./helper.env\n");
    writeFileSync(join(dir, "helper.env"), "FOO=1\n");
    runGit(dir, ["add", "."]);
    runGit(dir, ["commit", "-q", "-m", "first"]);
    const firstSha = runGit(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
    runGit(dir, ["add", "."]);
    runGit(dir, ["commit", "-q", "-m", "second"]);
    const secondSha = runGit(dir, ["rev-parse", "HEAD"]);
    run(dir, firstSha, secondSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.each([
  ["a.ts\0b.ts\0", ["a.ts", "b.ts"]],
  ["", []],
] as const)("parseNulPaths splits %j", (input, expected) => {
  expect(parseNulPaths(input)).toEqual(expected);
});

test("readShellTreeInputs finds sourced shell files in a commit tree", () => {
  withTempGitRepo((dir, firstSha) => {
    const inputs = readShellTreeInputs(dir, firstSha);
    expect(inputs.sourced).toContain("helper.env");
  });
});

test("verifyCommitRange accepts fast-forward and falls back on zero or reversed ranges", () => {
  withTempGitRepo((dir, firstSha, secondSha) => {
    expect(verifyCommitRange(dir, `${firstSha}..${secondSha}`)).toEqual({
      base: firstSha,
      head: secondSha,
    });
    expect(verifyCommitRange(dir, `0000000..${secondSha}`)).toEqual({
      fallback: `0000000..${secondSha} starts a new branch`,
    });
    expect(verifyCommitRange(dir, `${secondSha}..${firstSha}`)).toEqual({
      fallback: `${secondSha}..${firstSha} is not a verifiable fast-forward`,
    });
    expect(verifyCommitRange(dir, `deadbeef..${secondSha}`)).toEqual({
      fallback: `deadbeef..${secondSha} starts at a commit this clone lacks`,
    });
  });
});

test("collectRangeChanges lists changed paths without reading shell trees", () => {
  withTempGitRepo((dir, firstSha, secondSha) => {
    const result = collectRangeChanges(dir, [`${firstSha}..${secondSha}`]);
    expect(result).toEqual({
      paths: new Set(["app.ts"]),
      shellShebangs: new Set(),
      sourcedPaths: new Set(),
      since: firstSha.slice(0, 9),
    });
  });
});

test("collectRangeChangesWithShell lists changed paths and shell trees across pushed ranges", () => {
  withTempGitRepo((dir, firstSha, secondSha) => {
    const result = collectRangeChangesWithShell(dir, [`${firstSha}..${secondSha}`]);
    expect("fallback" in result).toBe(false);
    expect(result).toEqual({
      paths: new Set(["app.ts"]),
      shellShebangs: new Set(),
      sourcedPaths: new Set(["helper.env"]),
      since: firstSha.slice(0, 9),
    });
  });
});

test("resolveRangePaths verifies a single range and returns its touched paths", () => {
  withTempGitRepo((dir, firstSha, secondSha) => {
    expect(resolveRangePaths(dir, `${firstSha}..${secondSha}`)).toEqual({
      base: firstSha,
      head: secondSha,
      touched: ["app.ts"],
    });
    expect(resolveRangePaths(dir, `0000000..${secondSha}`)).toEqual({
      fallback: `0000000..${secondSha} starts a new branch`,
    });
  });
});

test("collectRangeChangesWithShell surfaces an earlier range shell-read fallback before a later range fallback", () => {
  withTempGitRepo((dir, firstSha, secondSha) => {
    const blobSha = runGit(dir, ["rev-parse", `${firstSha}:base.sh`]);
    rmSync(join(dir, ".git/objects", blobSha.slice(0, 2), blobSha.slice(2)));
    const result = collectRangeChangesWithShell(dir, [
      `${firstSha}..${secondSha}`,
      `0000000..${secondSha}`,
    ]);
    expect(result).toEqual({
      fallback: "git could not read shell inputs in the pushed ranges",
    });
  });
});

test("readWorkingTreeShellInputs detects untracked shebang shell scripts", () => {
  withTempGitRepo((dir, _firstSha, secondSha) => {
    writeFileSync(join(dir, "tool"), "#!/usr/bin/env bash\necho hi\n");
    const result = readWorkingTreeShellInputs(dir, secondSha, new Set(["tool"]));
    expect(result.shellShebangs).toEqual(new Set(["tool"]));
    expect(result.sourcedPaths).toEqual(new Set(["helper.env"]));
  });
});

test("collectWorkingTreeChanges includes untracked files and falls back outside a git repo", () => {
  withTempGitRepo((dir) => {
    writeFileSync(join(dir, "extra.txt"), "hello\n");
    const result = collectWorkingTreeChanges(dir);
    expect(result).toEqual({
      paths: new Set(["extra.txt"]),
      shellShebangs: new Set(),
      sourcedPaths: new Set(),
      since: "HEAD",
    });
  });
  const plain = mkdtempSync(join(tmpdir(), "non-git-dir-"));
  try {
    expect(collectWorkingTreeChanges(plain)).toEqual({
      fallback: "git could not list the changes",
    });
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test("collectWorkingTreeChangesWithShell includes shell inputs for changed working tree files", () => {
  withTempGitRepo((dir) => {
    writeFileSync(join(dir, "tool"), "#!/usr/bin/env bash\necho hi\n");
    const result = collectWorkingTreeChangesWithShell(dir);
    expect(result).toEqual({
      paths: new Set(["tool"]),
      shellShebangs: new Set(["tool"]),
      sourcedPaths: new Set(["helper.env"]),
      since: "HEAD",
    });
  });
});
