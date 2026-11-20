import process from "node:process";

// The Vitest runner must load Vite before Stryker installs its stack-trace hook on Bun.
await import("@stryker-mutator/vitest-runner");
const { StrykerCli } = await import("@stryker-mutator/core");
process.title = "stryker";
new StrykerCli([process.execPath, "stryker", "run", ...process.argv.slice(2)]).run();
