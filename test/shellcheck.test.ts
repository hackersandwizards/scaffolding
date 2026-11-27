import { rejection } from "@hackersandwizards/scaffolding/rejection";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { extractPinnedBinary, pinnedBinary, scaffoldingCache } from "../lib/pinned-binary.ts";
import { shellcheckPin } from "../lib/pinned-binary-assets.ts";
import {
  downloadShellcheckArchive,
  extractShellcheckBinary,
  shellcheckBinary,
} from "../lib/shellcheck.ts";
import { testDirectory } from "./test-directory.ts";

const shellcheckArchitectures = new Map([
  ["arm64", "aarch64"],
  ["x64", "x86_64"],
]);
const shellcheckArch = shellcheckArchitectures.get(process.arch) ?? process.arch;

test.each([
  [
    "linux.x86_64",
    "HTTP 429 blocked the release download. Check access to the release URL and rerun the check.",
  ],
])("reports a failed release response before reading the archive", async (target, expected) => {
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
});

test("explains a failed request for a ShellCheck release", async () => {
  const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  try {
    expect(await rejection(downloadShellcheckArchive("linux.x86_64", "unused"))).toContain(
      "The check could not reach the release URL (offline). Check network access and rerun the check.",
    );
  } finally {
    request.mockRestore();
  }
});

test("explains why ShellCheck cannot run without a platform pin", async () => {
  using temp = testDirectory();
  const pin = { ...shellcheckPin, assets: new Map() };
  expect(await rejection(pinnedBinary(temp.folder, "shellcheck", pin))).toContain(
    `No pinned ShellCheck v0.11.0 asset for ${process.platform}.${shellcheckArch}, so the check cannot run here. Run it on macOS or Linux on arm64 or x86-64.`,
  );
});

test.each([
  [
    "directory",
    (binary: string) => mkdirSync(binary),
    `The ShellCheck cache binary at PATH must be a regular file before it can be verified. Remove that cache entry and rerun the check to download it again.`,
  ],
  [
    "wrong bytes",
    (binary: string) => writeFileSync(binary, "wrong bytes"),
    `The cached ShellCheck v0.11.0 binary at PATH failed its checksum check. Remove that file and rerun the check to download a verified copy.`,
  ],
])("explains a cached ShellCheck binary containing %s", async (_, plant, expected) => {
  using temp = testDirectory();
  const cache = scaffoldingCache(temp.folder, ["shellcheck", "v0.11.0"], "ShellCheck");
  const binary = join(cache, "shellcheck");
  plant(binary);
  expect(await rejection(shellcheckBinary(temp.folder))).toContain(
    expected.replace("PATH", binary),
  );
});

test("explains a symlink in the ShellCheck cache path", () => {
  using temp = testDirectory();
  using target = testDirectory();
  const link = join(temp.folder, "node_modules");
  symlinkSync(target.folder, link);
  expect(() => scaffoldingCache(temp.folder, ["shellcheck"], "ShellCheck")).toThrow(
    `The ShellCheck cache path ${link} cannot be used because it is a symlink. Replace the link with a real directory and rerun the check.`,
  );
});

test("explains an extracted binary that fails its checksum", () => {
  using scratch = testDirectory();
  expect(() =>
    extractPinnedBinary(scratch.folder, Buffer.from("invalid bytes"), {
      tool: "shellcheck",
      label: "ShellCheck",
      asset: ["shellcheck", "expected checksum"],
    }),
  ).toThrow(
    "The binary checksum does not match the pin, so the check rejected the executable. Rerun the check and report a persistent mismatch to the scaffolding maintainer.",
  );
});

test("explains how to recover when the ShellCheck archive cannot be unpacked", () => {
  using scratch = testDirectory();
  expect(() =>
    extractShellcheckBinary(scratch.folder, Buffer.from("invalid archive"), "unused"),
  ).toThrow(
    /^tar could not extract the ShellCheck binary \([\s\S]+\)\. Check that tar is available in \/usr\/bin or \/bin and use the error to fix the extraction failure\.$/,
  );
});

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
