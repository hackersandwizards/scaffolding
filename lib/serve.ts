// A server a gate step starts for itself, on a port the system hands out, so two steps or two
// sessions never meet on one fixed port: two checks defaulting to one port redded each other,
// and a server left over from an earlier run answered for the new build.
import { createServer } from "node:net";
import { availableParallelism, loadavg } from "node:os";
import { spawnServingCommand, ServingProcess } from "./serving-process.ts";

/** The machine's one-minute load against its cores (SCAFFOLDING_LOAD stands in for the load), and
 * how many times a wait for wall time stretches under it: 1 up to one waiting process per core,
 * load per core above, at most 10. */
export function machineLoad(): { load: number; cores: number; factor: number } {
  const load = Number(process.env.SCAFFOLDING_LOAD || loadavg()[0]);
  const cores = availableParallelism();
  return { load, cores, factor: Math.min(10, Math.max(1, load / cores || 1)) };
}

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
 * stop. Fails after `timeoutMs` without an answer (20 s times the machine's load factor), or when
 * the server exits first, naming its exit code and the end of its stderr. `stderr: true` also passes
 * the server's stderr through, so a render error after the start shows its stack. */
export async function serve(
  command: string[],
  {
    env = {},
    timeoutMs = 20_000 * machineLoad().factor,
    stderr = false,
  }: { env?: Record<string, string>; timeoutMs?: number; stderr?: boolean } = {},
): Promise<{ url: string; stop: () => void }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const running = new ServingProcess(spawnServingCommand(command, port, env), stderr);
  for (const end = Date.now() + timeoutMs; Date.now() < end && !running.exited;) {
    const answered = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(1, end - Date.now())),
    }).then(
      () => true,
      () => false,
    );
    // An answer after the server exited came from another process that took the port meanwhile.
    if (answered && !running.exited) return { url, stop: running.stop };
    await new Promise((r) => setTimeout(r, 200));
  }
  running.stop();
  // The stream can trail the exit event by a tick; its last lines say why.
  await new Promise((r) => setTimeout(r, 50));
  throw new Error(
    `${command.join(" ")}: no answer on ${url}${running.exited}${running.said && `\n${running.said.trimEnd()}`}`,
  );
}
