import { afterEach, beforeEach } from "vitest";

let savedGitEnv: [string, string | undefined][] = [];

export function clearGitEnv(): void {
  savedGitEnv = Object.entries(process.env).filter(([key]) => key.startsWith("GIT_"));
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
