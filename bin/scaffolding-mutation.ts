#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { spawn } from "node:child_process";
import { help } from "../lib/help.ts";
import { SIGNALS } from "../lib/repo.ts";

export async function runMutation(
  [command, ...args]: [string, ...string[]],
  limitMs = 15 * 60_000,
): Promise<number> {
  // Stryker forks workers. Stop the whole group, even if a worker ignores termination signals.
  const child = spawn(command, args, { detached: true, stdio: "inherit" });
  const stop = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  const handlers = SIGNALS.map((signal) => {
    const forward = () => stop(signal);
    process.on(signal, forward);
    return { signal, forward };
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop("SIGKILL");
    console.error(
      "Mutation testing reached its 15-minute wall limit. Narrow the run with --mutate <files>.",
    );
  }, limitMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    return timedOut ? 124 : (code ?? 1);
  } catch (error) {
    console.error("[scaffolding-mutation]", error);
    return 1;
  } finally {
    clearTimeout(timer);
    for (const { signal, forward } of handlers) process.off(signal, forward);
  }
}

if (import.meta.main) {
  help("scaffolding-mutation");
  process.exitCode = await runMutation(["stryker", "run", ...process.argv.slice(2)]);
}
