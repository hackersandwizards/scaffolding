import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  installedChromeRelativePath,
  moveChromeBuild,
  pruneChromeBuildArchives,
  retireChromeBuild,
} from "../lib/chrome-installation.ts";
import { testDirectory } from "./test-directory.ts";

test.each([["/cache/job", "/cache/job/..unexpected/chrome", undefined]])(
  "rejects a staged path whose relative name starts with two dots",
  (stage, output, expected) => {
    expect(installedChromeRelativePath(stage, output)).toBe(expected);
  },
);

test.each([["110-linux.zip", false]])(
  "prunes the expired archive beside the staged build",
  (name, expected) => {
    using directory = testDirectory();
    const archive = join(directory.folder, name);
    writeFileSync(archive, "old");
    utimesSync(archive, 0, 0);
    pruneChromeBuildArchives(directory.folder, "linux-110");
    expect(existsSync(archive)).toBe(expected);
  },
);

test.each([[{ destination: "died", contents: "old executable" }, true]])(
  "moves the incomplete build to the replacement staging directory",
  ({ destination, contents }, expected) => {
    using directory = testDirectory();
    const old = join(directory.folder, "old");
    const staged = join(directory.folder, "staged");
    mkdirSync(old);
    mkdirSync(staged);
    writeFileSync(join(old, "chrome"), contents);
    retireChromeBuild(old, staged);
    expect(existsSync(join(staged, destination, "chrome"))).toBe(expected);
  },
);

test.each([["110-linux.zip", false]])(
  "leaves a competing unpack in place after a directory collision",
  (name, expected) => {
    using directory = testDirectory();
    const old = join(directory.folder, "linux-110");
    const staged = join(directory.folder, "staged");
    const executable = join(old, "chrome");
    mkdirSync(old);
    mkdirSync(staged);
    writeFileSync(executable, "not whole");
    writeFileSync(join(directory.folder, name), "unpacking");
    expect(moveChromeBuild(staged, old, executable)).toBe(expected);
  },
);
