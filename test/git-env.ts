import { afterEach, beforeEach } from "vitest";

let savedGitEnv: [string, string | undefined][] = [];

const gitEnvKey = (key: string) => key.startsWith("GIT_");

export function gitFixtureEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !gitEnvKey(key)));
}

export function clearGitEnv(): void {
  savedGitEnv = Object.entries(process.env).filter(([key]) => gitEnvKey(key));
  for (const [key] of savedGitEnv) delete process.env[key];
}

export function restoreGitEnv(): void {
  for (const [key, value] of savedGitEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedGitEnv = [];
}

export function installCleanGitEnvHooks(): void {
  beforeEach(clearGitEnv);
  afterEach(restoreGitEnv);
}
