import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runTimed, signalTimedGroup } from "../lib/run-timed.ts";

const cases = [
  { exits: true, limitMs: 500, graceMs: 100, graceToCount: 0 },
  { exits: false, limitMs: 500, graceMs: 100, graceToCount: 1 },
].map(({ graceToCount, ...input }) => ({
  ...input,
  minimumElapsed: input.limitMs + graceToCount * input.graceMs - 10,
}));

test.each(cases)(
  "runTimed times out a child with exit on SIGTERM = $exits",
  async ({ exits, limitMs, graceMs, minimumElapsed }) => {
    const dir = mkdtempSync(join(tmpdir(), "polish-codex-run-timed-"));
    const marker = join(dir, "term");
    const options = {
      name: "run-timed-test",
      limitMs,
      graceMs,
      timeoutMessage: "check reached its wall limit",
    };
    const script = `
    const { writeFileSync } = require("node:fs");
    const marker = ${JSON.stringify(marker)};
    process.on("SIGTERM", () => {
      writeFileSync(marker, "SIGTERM");
      if (${exits}) process.exit(0);
    });
    setTimeout(() => writeFileSync(marker, "finished"), 2500);
  `;
    try {
      const started = performance.now();
      const status = await runTimed([process.execPath, "--no-env-file", "-e", script], options);
      const elapsed = performance.now() - started;
      expect(status).toBe(124);
      expect(readFileSync(marker, "utf8")).toBe("SIGTERM");
      expect(elapsed).toBeGreaterThanOrEqual(minimumElapsed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.each([[98765, "SIGINT", -98765] as const])(
  "ignores a vanished subprocess group",
  (pid, signal, target) => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("vanished"), { code: "ESRCH" });
    });
    try {
      expect(() => signalTimedGroup({ pid }, signal)).not.toThrow();
      expect(kill).toHaveBeenCalledWith(target, signal);
    } finally {
      kill.mockRestore();
    }
  },
);
