import { execFileSync } from "node:child_process";
import { test } from "vitest";

test("shared configs expose their types to strict TypeScript consumers", () => {
  execFileSync(
    process.execPath,
    [
      "run",
      "tsc",
      "--ignoreConfig",
      "--strict",
      "--noEmit",
      "--skipLibCheck",
      "--target",
      "esnext",
      "--module",
      "nodeNext",
      "test/config-exports.ts",
    ],
    { cwd: new URL("../", import.meta.url), stdio: "inherit" },
  );
});
