// A server a gate step starts for itself, on a port the system hands out, so two steps or two
// sessions never meet on one fixed port: two trainer-hub checks defaulting to 4398 redded each
// other on 2026-11-02, and a server left over from an earlier run answered for the new build.
import { spawn } from "node:child_process";
import { createServer } from "node:net";

/** A port nothing listens on now. */
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
    probe.on("error", fail);
  });
}

/** Starts `command` with HOST and PORT set, waits until it answers, and hands back its URL and a
 * stop. Fails after `timeoutMs` without an answer, or when the server exits first. */
export async function serve(
  command: string[],
  { env = {}, timeoutMs = 20_000 }: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ url: string; stop: () => void }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(command[0]!, command.slice(1), {
    env: { ...process.env, ...env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: "ignore",
  });
  let exited = false;
  server.on("exit", () => (exited = true));
  server.on("error", () => (exited = true));
  const stop = () => void server.kill();
  for (const end = Date.now() + timeoutMs; Date.now() < end && !exited;) {
    if (
      await fetch(url, { signal: AbortSignal.timeout(Math.max(1, end - Date.now())) }).then(
        () => true,
        () => false,
      )
    )
      return { url, stop };
    await new Promise((r) => setTimeout(r, 200));
  }
  stop();
  throw new Error(`${command.join(" ")}: no answer on ${url}${exited ? ", it exited" : ""}`);
}
