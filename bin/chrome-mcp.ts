#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
//   chrome-mcp [flag...]   the chrome-devtools MCP server this package pins, headless and isolated, on
//                          Chrome for Testing: CHROME_BINARY, else the build the repository's
//                          puppeteer-core pins, else the newest cached build, else the pinned build
//                          or stable installed; further flags go to chrome-devtools-mcp
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { cachedChrome, chromeBinary, INSTALL_HINT, NO_KEYCHAIN } from "../lib/chrome.ts";

// Any cached build before a download of about 570 MB, which the server's start waits for: a
// browser an agent drives needs no pinned build, a test comparing pixels does.
const chrome =
  process.env.CHROME_BINARY ?? cachedChrome() ?? cachedChrome({ anyBuild: true }) ?? chromeBinary();
if (!chrome) {
  console.error(`[chrome-mcp] ${INSTALL_HINT}`);
  process.exit(1);
}
const pkg = createRequire(import.meta.url).resolve("chrome-devtools-mcp/package.json");
const { bin } = JSON.parse(readFileSync(pkg, "utf8"));
const server = spawn(
  process.execPath,
  [
    join(dirname(pkg), bin["chrome-devtools-mcp"]),
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
