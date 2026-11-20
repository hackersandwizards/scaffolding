import { expect, test, vi } from "vitest";
import { runMutation } from "../bin/scaffolding-mutation.ts";

test("stops a hung mutation command at the wall limit and tells the caller how to narrow it", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(await runMutation([process.execPath, "-e", "setInterval(() => {}, 1000)"], 25)).toBe(
      124,
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/15-minute wall limit.*--mutate <files>/),
    );
  } finally {
    stderr.mockRestore();
  }
});

test("returns the mutation command's exit status when it finishes before the limit", async () => {
  expect(await runMutation([process.execPath, "-e", "process.exit(7)"])).toBe(7);
});
