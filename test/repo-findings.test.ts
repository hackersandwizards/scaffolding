import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { newestTag, printCheckFindings } from "../lib/repo.ts";
import { runTool } from "./preloaded-check.ts";
import { testDirectory } from "./test-directory.ts";

test.each([
  [
    { check: "fallback", path: "test.md", message: "finding", text: "", prefix: "" },
    "[] test.md: finding",
  ],
])("prints an explicitly empty prefix before the summary", (finding, expected) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    printCheckFindings("fallback", [finding], performance.now());
    expect(log).toHaveBeenNthCalledWith(1, expected);
    expect(log).toHaveBeenNthCalledWith(2, expect.stringContaining("[fallback] 1 findings, "));
  } finally {
    log.mockRestore();
  }
});

test("explains why a timed-out tag lookup could not select a release", async () => {
  using dir = testDirectory();
  writeFileSync(join(dir.folder, "git"), "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
  const env = vi.stubEnv("PATH", dir.folder).stubEnv("SCAFFOLDING_FETCH_WAIT_S", "1");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await newestTag("example.git");
    expect(log).toHaveBeenCalledWith(
      "git ls-remote example.git: no answer within 1 s, so the latest release tag is unknown. Check access to the remote, or increase SCAFFOLDING_FETCH_WAIT_S if the connection is slow.",
    );
  } finally {
    log.mockRestore();
    env.unstubAllEnvs();
  }
});

test("explains why the shipped-file check cannot continue when packing fails", () => {
  using dir = testDirectory();
  const mock = join(dir.folder, "pack");
  writeFileSync(mock, "#!/bin/sh\nprintf 'invalid files entry' >&2\nexit 1\n", { mode: 0o755 });
  const code = `import { shippedFiles } from ${JSON.stringify(join(import.meta.dirname, "../lib/repo.ts"))};
Object.defineProperty(process, "execPath", { value: ${JSON.stringify(mock)} });
shippedFiles(process.cwd(), { files: true }, "spaces");`;
  const result = runTool(dir.folder, "", ["-e", code]);
  expect(result.stderr).toBe(
    "[spaces] bun pm pack listed no files, so the check cannot tell what ships (invalid files entry). Fix the package.json or packaging error shown and verify with bun pm pack --dry-run --ignore-scripts.\n",
  );
});
