import { readFileSync } from "node:fs";

// A process starting on a loaded machine took more than 5 s to write its lock, and the read after
// a silent timeout failed on a file that was not there yet; so the wait is long and says when it
// runs out.
interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

export async function until(
  ready: () => boolean,
  what: string,
  { timeoutMs = 20_000, intervalMs = 50, signal }: WaitOptions = {},
): Promise<void> {
  for (
    const end = Date.now() + timeoutMs;
    !signal?.aborted && !ready();
    await Bun.sleep(intervalMs)
  )
    if (Date.now() > end) throw new Error(`still waiting for ${what} after ${timeoutMs / 1000} s`);
}

export function pathReady<T>(
  path: string,
  read: (path: string) => T,
  ready: (value: T) => boolean,
) {
  let value: T;
  try {
    value = read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return ready(value);
}

export function fileReady(path: string, ready: (value: string) => boolean) {
  return pathReady(path, (name) => readFileSync(name, "utf8"), ready);
}

export async function untilBefore(
  ready: () => boolean,
  what: string,
  stop: (signal: AbortSignal) => Promise<unknown>,
) {
  const controller = new AbortController();
  const waiter = until(ready, what, { signal: controller.signal });
  try {
    await Promise.race([waiter, stop(controller.signal)]);
  } finally {
    controller.abort();
    await waiter;
  }
}
