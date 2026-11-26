import { expect, test } from "vitest";
import { matchGitShellShebangs, parseShellSourceWords } from "../lib/shell-inputs.ts";

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
