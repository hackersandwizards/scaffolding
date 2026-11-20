import { spawn } from "node:child_process";
import { SIGNALS } from "./repo.ts";

export async function runTimed(
  [command, ...args]: [string, ...string[]],
  {
    name,
    limitMs,
    timeoutMessage,
    env,
  }: {
    name: string;
    limitMs: number;
    timeoutMessage: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<number> {
  // Stop subprocess workers as well, even if they ignore termination signals.
  const child = spawn(command, args, { detached: true, stdio: "inherit", env });
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
    console.error(timeoutMessage);
  }, limitMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    return timedOut ? 124 : (code ?? 1);
  } catch (error) {
    console.error(`[${name}]`, error);
    return 1;
  } finally {
    clearTimeout(timer);
    for (const { signal, forward } of handlers) process.off(signal, forward);
  }
}
