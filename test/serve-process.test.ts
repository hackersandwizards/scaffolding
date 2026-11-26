import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { spawnServingCommand, ServingProcess } from "../lib/serving-process.ts";

test.each([[Buffer.from("x".repeat(2001) + "end"), "x".repeat(1997) + "end"]])(
  "retains the tail of stderr as an exit diagnostic",
  (output, expected) => {
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stderr }) as unknown as ChildProcess;
    const server = new ServingProcess(child, false);
    stderr.write(output);
    child.emit("exit", 0, "SIGTERM");
    expect(server.said).toBe(expected);
    expect(server.exited).toBe(", it exited with SIGTERM");
  },
);

test.each([[undefined, false]])(
  "does not signal a process group without a child PID",
  (pid, expected) => {
    const child = Object.assign(new EventEmitter(), { pid }) as ChildProcess;
    const server = new ServingProcess(child, false);
    expect(server.signalGroup(0)).toBe(expected);
  },
);

test.each([[43210, -43210]])(
  "signals a serving group only once on repeated stop calls",
  (pid, expected) => {
    const child = new EventEmitter() as ChildProcess;
    const server = new ServingProcess(child, false);
    Object.defineProperty(child, "pid", { value: pid });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("finished"), { code: "ESRCH" });
    });
    try {
      server.stop();
      server.stop();
      expect(kill).toHaveBeenCalledExactlyOnceWith(expected, "SIGTERM");
    } finally {
      kill.mockRestore();
    }
  },
);

test.each([[[], "serve: command must not be empty"]])(
  "rejects an empty command before spawning a server",
  (command, expected) => {
    expect(() => spawnServingCommand(command, 8000, {})).toThrow(expected);
  },
);
