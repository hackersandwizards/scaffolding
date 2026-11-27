import { expect, test } from "vitest";
import { git } from "../lib/repo.ts";
import {
  gitShellShebangs,
  matchGitShellShebangs,
  parseShellSourceWords,
} from "../lib/shell-inputs.ts";
import { installCleanGitEnvHooks } from "./git-env.ts";
import { testDirectory } from "./test-directory.ts";

installCleanGitEnvHooks();

test.each([
  [
    '# source ignored\n. "one two"\n# shellcheck source-path="SCRIPTDIR/another folder" source=three\nsource "$dynamic"',
    { names: ["one two", "three", undefined], directories: ["SCRIPTDIR/another folder"] },
  ],
])("reads source directives and commands in their written order", (input, expected) => {
  expect(parseShellSourceWords(input)).toEqual(expected);
});

test.each([
  [["HEAD:two\0", "1\0#!/bin/bash\n", "HEAD:one\0", "1\0#!/bin/sh\n"].join(""), ["two", "one"]],
])("preserves Git shebang record order after stripping the revision", (input, expected) => {
  expect(matchGitShellShebangs(input, new Set(["one", "two"]), "HEAD")).toEqual(expected);
});

test("explains how to diagnose a Git shell input read failure", () => {
  using fixture = testDirectory();
  git(["init", "-q"], fixture.folder);
  expect(() => gitShellShebangs(fixture.folder, ["script"], "missing")).toThrow(
    new Error(
      "git grep could not read shell shebangs, so shell script discovery is incomplete. Use `git status` to check the index and `git rev-parse` to verify any revision supplied to the check.",
    ),
  );
});
