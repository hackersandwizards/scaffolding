import { rejection } from "@hackersandwizards/scaffolding/rejection";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { downloadShellcheckArchive, extractShellcheckBinary } from "../lib/shellcheck.ts";
import { testDirectory } from "./test-directory.ts";

test.each([["linux.x86_64", "HTTP 429"]])(
  "reports a failed release response before reading the archive",
  async (target, expected) => {
    const read = vi.fn();
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: false, status: 429, arrayBuffer: read } as unknown as Response);
    try {
      expect(await rejection(downloadShellcheckArchive(target, "unused"))).toContain(expected);
      expect(read).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  },
);

test.each([["shellcheck-v0.11.0/shellcheck", "binary example"]])(
  "extracts only the verified member as an executable",
  (member, expected) => {
    using temp = testDirectory();
    using scratch = testDirectory();
    mkdirSync(join(temp.folder, "shellcheck-v0.11.0"));
    writeFileSync(join(temp.folder, member), expected);
    writeFileSync(join(temp.folder, "other.txt"), "ignored");
    const archive = spawnSync("tar", ["-czf", "-", member, "other.txt"], {
      cwd: temp.folder,
    }).stdout;
    const checksum = createHash("sha256").update(expected).digest("hex");
    const binary = extractShellcheckBinary(scratch.folder, archive, checksum);
    expect(readFileSync(binary, "utf8")).toBe(expected);
    expect(statSync(binary).mode & 0o777).toBe(0o755);
    expect(existsSync(join(scratch.folder, "other.txt"))).toBe(false);
  },
);
