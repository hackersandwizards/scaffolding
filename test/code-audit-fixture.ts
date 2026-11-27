import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitFixtureEnv } from "./git-env.ts";

export function writeAuditFiles(root: string, files: Record<string, string | undefined>) {
  for (const [name, source] of Object.entries(files)) {
    if (source === undefined) continue;
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
}

export function auditFixture(root: string, files: Record<string, string | undefined>) {
  writeAuditFiles(root, files);
  for (const args of [
    ["init", "-q"],
    ["add", "--", ...Object.keys(files)],
  ]) {
    const git = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitFixtureEnv() });
    if (git.status !== 0) throw new Error(git.stderr || git.error?.message);
  }
}

export function runCodeAudit(root: string, step: "duplicates" | "unused") {
  const cli = join(import.meta.dirname, `../bin/check-${step}.ts`);
  const run = spawnSync(process.execPath, ["--no-env-file", cli], {
    cwd: root,
    encoding: "utf8",
    env: gitFixtureEnv(),
  });
  return { status: run.status, output: run.stdout + run.stderr };
}
