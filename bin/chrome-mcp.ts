#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cachedChrome, chromeBinary, INSTALL_HINT, NO_KEYCHAIN } from "../lib/chrome.ts";
import { help } from "../lib/help.ts";

help("chrome-mcp");

// Any cached build before a download of about 570 MB, which the server's start waits for: a
// browser an agent drives needs no pinned build, a test comparing pixels does.
const chrome =
  process.env.CHROME_BINARY || cachedChrome() || cachedChrome({ anyBuild: true }) || chromeBinary();
if (!chrome) {
  console.error(`[chrome-mcp] ${INSTALL_HINT}`);
  process.exit(1);
}
const pkg = import.meta.resolve("chrome-devtools-mcp/package.json");
const {
  default: { bin },
} = await import("chrome-devtools-mcp/package.json", { with: { type: "json" } });
const entry = bin["chrome-devtools-mcp"];
if (typeof entry !== "string") {
  console.error("[chrome-mcp] chrome-devtools-mcp names no bin of that name");
  process.exit(1);
}
const server = spawn(
  process.execPath,
  [
    fileURLToPath(new URL(entry, pkg)),
    `--executablePath=${chrome}`,
    "--headless",
    "--isolated",
    "--viewport=1920x1080",
    "--no-performance-crux",
    "--no-usage-statistics",
    ...NO_KEYCHAIN.map((arg) => `--chromeArg=${arg}`),
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 1));
