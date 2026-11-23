import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTimed } from "../lib/run-timed.ts";

test.each([true, false])("runTimed times out a child with exit on SIGTERM = %s", async (exits) => {
  const dir = mkdtempSync(join(tmpdir(), "polish-codex-run-timed-"));
  const marker = join(dir, "term");
  const options = {
    name: "run-timed-test",
    limitMs: 500,
    graceMs: 100,
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
    if (!exits) expect(elapsed).toBeGreaterThanOrEqual(options.limitMs + options.graceMs - 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
