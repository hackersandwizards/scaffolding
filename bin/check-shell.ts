#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathChunks, reader, repoRoot, withoutEnvFile } from "../lib/repo.ts";
import {
  gitShellShebangs,
  needsShellShebang,
  shellExtension,
  shellInput,
} from "../lib/shell-inputs.ts";
import { shellcheckBinary, shellcheckScratch } from "../lib/shellcheck.ts";
import { stagedDiff, stagedPaths } from "../lib/staged-paths.ts";
import { indexInputs, inNodeModules, regularInput, trackedInputs } from "../lib/tracked-inputs.ts";

withoutEnvFile("shell");

function lintShell(binary: string, root: string, files: string[]) {
  const rc = regularInput(root, ".shellcheckrc") ? ["--rcfile=.shellcheckrc"] : ["--norc"];
  let status = 0;
  let findings = false;
  for (const chunk of pathChunks(files)) {
    const run = spawnSync(
      binary,
      ["-S", "warning", ...rc, "--", ...chunk.map((path) => (path === "-" ? "./-" : path))],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, SHELLCHECK_OPTS: undefined },
      },
    );
    if (run.error) throw run.error;
    if (run.status === null)
      throw new Error(`ShellCheck terminated${run.signal ? ` by ${run.signal}` : ""}`);
    findings ||= run.status === 1;
    status ||= run.status;
  }
  if (findings) console.log("Repair each ShellCheck finding in the script.");
  return status;
}

function lintStagedShell(binary: string, root: string, files: string[]) {
  const snapshot = shellcheckScratch(dirname(binary), "staged");
  const read = reader(root, true);
  try {
    const tracked = indexInputs(root);
    for (const path of [
      ...indexShellScripts(root, tracked),
      ...tracked.filter((path) => path === ".shellcheckrc"),
    ]) {
      const file = join(snapshot, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, read(path));
    }
    return lintShell(binary, snapshot, files);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function indexShellScripts(root: string, paths: string[]) {
  return [
    ...paths.filter((path) => shellExtension.test(path)),
    ...gitShellShebangs(root, paths.filter(needsShellShebang)),
  ];
}

try {
  const root = realpathSync(repoRoot());
  const staged = process.argv[2] === "--staged";
  let files: string[];
  if (staged) {
    const paths = stagedPaths(stagedDiff(root)).regularPaths.filter((path) => !inNodeModules(path));
    files = indexShellScripts(root, paths);
  } else {
    files = trackedInputs(root).filter((path) => shellInput(path, join(root, path)));
  }
  if (!files.length) {
    if (!staged) console.log("[shell] no tracked shell scripts");
    process.exit(0);
  }
  const binary = await shellcheckBinary(root);
  process.exit(staged ? lintStagedShell(binary, root, files) : lintShell(binary, root, files));
} catch (error) {
  console.error(`[shell] ${(error as Error).message}`);
  process.exit(1);
}
