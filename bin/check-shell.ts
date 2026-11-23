#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathChunks, reader, repoRoot, withoutEnvFile } from "../lib/repo.ts";
import {
  gitShellShebangs,
  needsShellShebang,
  shellExtension,
  shellInput,
} from "../lib/shell-inputs.ts";
import { stagedDiff, stagedPaths } from "../lib/staged-paths.ts";
import { indexInputs, inNodeModules, regularInput, trackedInputs } from "../lib/tracked-inputs.ts";

withoutEnvFile("shell");
const release = "v0.11.0";

async function shellcheckBinary(root: string): Promise<string> {
  let cache = root;
  for (const dir of ["node_modules", ".cache", "scaffolding", "shellcheck", release]) {
    cache = join(cache, dir);
    mkdirSync(cache, { recursive: true });
    if (!lstatSync(cache).isDirectory()) throw new Error("ShellCheck cache contains a symlink");
  }
  const name = process.platform === "win32" ? "shellcheck.exe" : "shellcheck";
  const binary = join(cache, name);
  const found = lstatSync(binary, { throwIfNoEntry: false });
  if (found) {
    if (!found.isFile()) throw new Error("ShellCheck cache binary must be a regular file");
    return binary;
  }
  const scratch = mkdtempSync(join(cache, "download-"));
  try {
    // The npm wrapper uses os.tmpdir() for extraction and reads its environment on import.
    for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = scratch;
    delete process.env.SHELLCHECKJS_BIN;
    delete process.env.SHELLCHECKJS_RELEASE;
    process.env.SHELLCHECKJS_LOGGER_LEVEL = "off";
    const { buildURL, download } = await import("shellcheck");
    const candidate = join(scratch, name);
    await download({ url: await buildURL({ release }), destination: candidate });
    const version = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (
      version.status !== 0 ||
      !version.stdout.split(/\r?\n/).includes(`version: ${release.slice(1)}`)
    )
      throw new Error("the downloaded binary did not report the requested version");
    renameSync(candidate, binary);
    return binary;
  } catch (error) {
    throw new Error(
      `could not download ShellCheck ${release}: ${(error as Error).message.replace(/\s+/g, " ")}`,
      { cause: error },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function lintShell(binary: string, root: string, files: string[]) {
  const rc = regularInput(root, ".shellcheckrc") ? ["--rcfile=.shellcheckrc"] : ["--norc"];
  let status = 0;
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
    status ||= run.status ?? 1;
  }
  return status;
}

function lintStagedShell(binary: string, root: string, files: string[]) {
  const snapshot = mkdtempSync(join(dirname(binary), "staged-"));
  const read = reader(root, true);
  try {
    const rc = indexInputs(root, ".shellcheckrc");
    for (const path of [...files, ...rc]) {
      const file = join(snapshot, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, read(path));
    }
    return lintShell(binary, snapshot, files);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

try {
  const root = realpathSync(repoRoot());
  const staged = process.argv[2] === "--staged";
  let files: string[];
  if (staged) {
    const paths = stagedPaths(stagedDiff(root)).regularPaths.filter((path) => !inNodeModules(path));
    files = [
      ...paths.filter((path) => shellExtension.test(path)),
      ...gitShellShebangs(root, paths.filter(needsShellShebang)),
    ];
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
