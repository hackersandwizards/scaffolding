import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitFixtureEnv } from "./git-env.ts";

export function runInputCheck(folder: string, command: string[], preload: string) {
  const hook = join(folder, "preload.ts");
  writeFileSync(hook, preload);
  const [name, ...args] = command;
  return (input?: string) =>
    spawnSync(
      process.execPath,
      [
        "--no-env-file",
        "--preload",
        hook,
        join(import.meta.dirname, "..", "bin", `${name}.ts`),
        ...args,
      ],
      { cwd: folder, encoding: "utf8", input, env: { ...gitFixtureEnv(), CI: "" } },
    );
}

export function inputTestRepo(folder: string) {
  execFileSync("git", ["init", "-q", "--template="], { cwd: folder, env: gitFixtureEnv() });
}

export const entry = (name: string) => join(import.meta.dirname, "..", "bin", `${name}.ts`);
export const runTool = (folder: string, source: string, args: string[]) => {
  const preload = join(folder, ".preload.ts");
  writeFileSync(preload, source);
  return spawnSync(process.execPath, ["--no-env-file", "--preload", preload, ...args], {
    cwd: folder,
    encoding: "utf8",
    env: gitFixtureEnv(),
  });
};

export const fixtureGit = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.email=fixture@example.test", "-c", "user.name=Fixture", ...args],
    {
      cwd,
      encoding: "utf8",
      env: gitFixtureEnv(),
    },
  ).trim();

export function writeToolFixture(folder: string, files: Record<string, string>) {
  fixtureGit(folder, "init", "-q");
  for (const [path, text] of Object.entries(files)) writeFileSync(join(folder, path), text);
  fixtureGit(folder, "add", "--", ...Object.keys(files));
  fixtureGit(folder, "commit", "-qm", "fixture");
}
