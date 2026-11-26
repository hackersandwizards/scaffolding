import { expect, test, vi } from "vitest";
import { printCheckFindings } from "../lib/repo.ts";

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
