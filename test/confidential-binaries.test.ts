import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  agentWorkCiFindings,
  BinaryContentScanner,
  compileOcrBinary,
  computeReaderCachePaths,
} from "../lib/confidential-binaries.ts";

function buildStoredZip(name: string, content: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + content.length, 16);
  return Buffer.concat([local, nameBuf, content, central, nameBuf, eocd]);
}

test("agentWorkCiFindings flags only binaries under docs/agent-work/", () => {
  const findings = agentWorkCiFindings([
    { where: "docs/agent-work/shot.png", data: Buffer.alloc(0) },
    { where: "nested/docs/agent-work/chart.png", data: Buffer.alloc(0) },
    { where: "docs/public.png", data: Buffer.alloc(0) },
  ]);
  expect(findings.map((item) => item.path)).toEqual([
    "docs/agent-work/shot.png",
    "nested/docs/agent-work/chart.png",
  ]);
  expect(findings[0].message).toContain("binary file in docs/agent-work not read");
});

test("compileOcrBinary returns an already-compiled cached binary path", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-bin-"));
  try {
    const source = join(dir, "ocr.swift");
    writeFileSync(source, "// stub");
    const digest = createHash("sha256").update("// stub").digest("hex").slice(0, 12);
    const cachedBin = join(dir, `ocr-${digest}`);
    writeFileSync(cachedBin, "stub-bin");
    expect(compileOcrBinary(source, dir)).toBe(cachedBin);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeReaderCachePaths changes when source or file bytes change", () => {
  const dir = mkdtempSync(join(tmpdir(), "reader-cache-"));
  try {
    const src = join(dir, "reader.ts");
    writeFileSync(src, "v1");
    const first = computeReaderCachePaths([{ where: "a.bin", data: Buffer.from("one") }], dir, [
      src,
    ]);
    const second = computeReaderCachePaths([{ where: "a.bin", data: Buffer.from("two") }], dir, [
      src,
    ]);
    writeFileSync(src, "v2");
    const updated = computeReaderCachePaths([{ where: "a.bin", data: Buffer.from("one") }], dir, [
      src,
    ]);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]).not.toBe(updated[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BinaryContentScanner extracts zip XML, passes fonts, refuses unknown binaries, and caches read files", () => {
  const dir = mkdtempSync(join(tmpdir(), "bin-scan-"));
  try {
    const src = join(dir, "reader.ts");
    const ocr = join(dir, "ocr.swift");
    writeFileSync(src, "v1");
    writeFileSync(ocr, "// ocr");
    const refused: string[] = [];
    const missing: string[] = [];
    const scanner = new BinaryContentScanner(
      dir,
      (where, entry, message) => refused.push(`${where}|${entry}|${message}`),
      (where, entry, message) => missing.push(`${where}|${entry}|${message}`),
    );
    const zipData = buildStoredZip("word/document.xml", Buffer.from("<p>Hel<span>lo</span></p>"));
    const fontData = Buffer.concat([Buffer.from("wOF2"), Buffer.from([0, 1, 2])]);
    const unknownData = Buffer.from([0xde, 0xad, 0x00, 0xbe]);
    const files = [
      { where: "deck.docx", data: zipData },
      { where: "font.woff2", data: fontData },
      { where: "blob.dat", data: unknownData },
    ];
    const texts = scanner.scanAll(files, [src], ocr);
    expect(texts.get("deck.docx")).toContain("Hello");
    expect(refused).toEqual([
      "blob.dat||binary file not read: remove the binary or replace it with a text or scannable format so confidential terms cannot slip into this public repository. Only if the binary genuinely belongs here and contains no confidential data, add an entry with a reason in package.json scaffolding.allow",
    ]);
    expect(missing).toEqual([]);

    const cachePaths = computeReaderCachePaths(files, dir, [src]);
    expect(existsSync(cachePaths[0])).toBe(true);
    expect(existsSync(cachePaths[2])).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BinaryContentScanner reuses pre-populated read cache without re-reading raw bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "bin-cache-hit-"));
  try {
    const src = join(dir, "reader.ts");
    const ocr = join(dir, "ocr.swift");
    writeFileSync(src, "v1");
    writeFileSync(ocr, "// ocr");
    const file = { where: "opaque.bin", data: Buffer.from([0, 1, 2, 3]) };
    const [cachePath] = computeReaderCachePaths([file], dir, [src]);
    mkdirSync(join(dir, "read"), { recursive: true });
    writeFileSync(cachePath, "cached-text");

    const refused: string[] = [];
    const scanner = new BinaryContentScanner(
      dir,
      (where) => refused.push(where),
      (where) => refused.push(where),
    );
    const texts = scanner.scanAll([file], [src], ocr);
    expect(texts.get("opaque.bin")).toBe("\ncached-text");
    expect(refused).toEqual([]);
    expect(readFileSync(cachePath, "utf8")).toBe("cached-text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
