import { spawn, type ChildProcess } from "node:child_process";
import { SIGNALS } from "./repo.ts";

export function signalTimedGroup(child: Pick<ChildProcess, "pid">, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

export async function runTimed(
  [command, ...args]: [string, ...string[]],
  {
    name,
    limitMs,
    graceMs = 10_000,
    timeoutMessage,
    env,
  }: {
    name: string;
    limitMs: number;
    graceMs?: number;
    timeoutMessage: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<number> {
  // Signal the subprocess workers as well as the child.
  const child = spawn(command, args, { detached: true, stdio: "inherit", env });
  const stop = (signal: NodeJS.Signals) => signalTimedGroup(child, signal);
  const handlers = SIGNALS.map((signal) => {
    const forward = () => stop(signal);
    process.on(signal, forward);
    return { signal, forward };
  });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    stop("SIGTERM");
    killTimer = setTimeout(() => stop("SIGKILL"), graceMs).unref();
    console.error(timeoutMessage);
  }, limitMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    return timedOut ? 124 : (code ?? 1);
  } catch (error) {
    console.error(
      `[${name}] Could not start ${command}. Use the error below to correct the executable path or its permissions.`,
      error,
    );
    return 1;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    for (const { signal, forward } of handlers) process.off(signal, forward);
  }
}
