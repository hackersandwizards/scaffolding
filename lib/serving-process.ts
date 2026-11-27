import { spawn, type ChildProcess } from "node:child_process";

export function spawnServingCommand(
  command: string[],
  port: number,
  env: Record<string, string>,
): ChildProcess {
  const [executable, ...args] = command;
  if (!executable)
    throw new Error(
      "serve: An empty command cannot start the server. Pass the server executable as the first command element.",
    );
  // In a group of its own, so stop() reaches a server a wrapper such as `bun run` starts too.
  return spawn(executable, args, {
    env: { ...process.env, ...env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
}

export class ServingProcess {
  said = "";
  exited = "";
  private stopping = false;
  private readonly server: ChildProcess;
  private readonly watcher: ChildProcess | undefined;

  constructor(server: ChildProcess, stderr: boolean) {
    this.server = server;
    // Where this process dies without stop(), killed by a signal included, the watcher's stdin
    // closes and it stops the server's group. In a group of its own and deaf to the signals that
    // end this process, so a signal to this process or its group never takes the watcher along.
    this.watcher = server.pid
      ? spawn("/bin/sh", ["-c", `trap '' INT TERM HUP; cat >/dev/null; kill -- -${server.pid}`], {
          stdio: ["pipe", "ignore", "ignore"],
          detached: true,
        }).on("error", () => {})
      : undefined;
    server.stderr?.on("data", (chunk: Buffer) => {
      if (stderr) process.stderr.write(chunk);
      this.said = (this.said + chunk).slice(-2000);
    });
    server.on(
      "exit",
      (code, signal) => (this.exited = `, it exited with ${signal ?? `code ${code}`}`),
    );
    server.on("error", (error) => (this.exited = `, it exited: ${error.message}`));
  }

  signalGroup(signal: NodeJS.Signals | 0) {
    const pid = this.server.pid;
    if (pid === undefined) return false;
    try {
      return process.kill(-pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ESRCH" || (signal === 0 && code === "EPERM")) return false;
      throw error;
    }
  }
  stop = () => {
    if (this.stopping) return;
    this.stopping = true;
    if (!this.signalGroup("SIGTERM")) {
      this.watcher?.kill("SIGKILL");
      return;
    }
    const timer = setTimeout(() => {
      this.signalGroup("SIGKILL");
      this.watcher?.kill("SIGKILL");
    }, 2000).unref();
    // Keep the watcher alive if the wrapper exits and a descendant closes stderr.
    this.server.once("close", () => {
      if (this.signalGroup(0)) return;
      clearTimeout(timer);
      this.watcher?.kill("SIGKILL");
    });
  };
}
