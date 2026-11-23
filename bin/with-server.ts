#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { parseArgs } from "node:util";
import { help } from "../lib/help.ts";
import { runTimed } from "../lib/run-timed.ts";
import { serve } from "../lib/serve.ts";

const usage =
  'usage: with-server [--timeout <seconds>] [--stderr] "<server command>" -- <check> [args...]';
help("with-server", usage);

function serverUsageError(message: string): never {
  console.error(`[with-server] ${message}\n${usage}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const check = args[separator + 1];
if (separator < 0 || !check) serverUsageError("expected -- followed by a check command");

const { values, positionals } = (() => {
  try {
    return parseArgs({
      args: args.slice(0, separator),
      allowPositionals: true,
      options: { timeout: { type: "string" }, stderr: { type: "boolean" } },
    });
  } catch (error) {
    return serverUsageError(String(error));
  }
})();
const [serverCommand] = positionals;
if (positionals.length !== 1 || !serverCommand?.trim()) {
  serverUsageError("expected one quoted server command");
}

const timeoutMs =
  values.timeout === undefined ? undefined : Math.ceil(Number(values.timeout) * 1000);
if (timeoutMs !== undefined && !(timeoutMs > 0 && timeoutMs <= 2_147_483_647)) {
  serverUsageError("--timeout must be a positive number of seconds within the timer range");
}

let server: Awaited<ReturnType<typeof serve>> | undefined;
try {
  server = await serve(["/bin/sh", "-c", serverCommand], { timeoutMs, stderr: values.stderr });
  const url = server.url;
  process.exitCode = await runTimed(
    [check, ...args.slice(separator + 2).map((arg) => arg.replaceAll("{url}", url))],
    {
      name: "with-server",
      limitMs: 120_000,
      timeoutMessage: "[with-server] check reached the two-minute wall limit",
    },
  );
} catch (error) {
  console.error(`[with-server] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  server?.stop();
}
