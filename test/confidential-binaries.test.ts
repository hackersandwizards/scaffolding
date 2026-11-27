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

test("computeReaderCachePaths distinguishes different readers for identical bytes", () => {
  const files = [
    { where: "sample.txt", data: Buffer.from("<p>sample</p>") },
    { where: "sample.xml", data: Buffer.from("<p>sample</p>") },
    { where: "sample.txt", data: Buffer.from("<p>sample</p>") },
  ];
  const [text, markup, repeated] = computeReaderCachePaths(files, "cache", []);
  expect(text).not.toBe(markup);
  expect(text).toBe(repeated);
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

function withIsolatedPath(binDir: string, run: () => void): void {
  const originalPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    run();
  } finally {
    process.env.PATH = originalPath;
  }
}

function writeExecutableStub(filePath: string, body: string): void {
  writeFileSync(filePath, body, { mode: 0o755 });
}

function setupOcrStub(dir: string, ocrSource: string, ocrText: string): void {
  const digest = createHash("sha256").update(readFileSync(ocrSource)).digest("hex").slice(0, 12);
  writeExecutableStub(
    join(dir, `ocr-${digest}`),
    `#!/bin/sh\nprintf '== %s\\n%s\\n' "$1" "${ocrText}"\n`,
  );
}

test("BinaryContentScanner marks an image unread without caching when OCR is unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), "bin-img-noocr-"));
  try {
    const src = join(dir, "reader.ts");
    const ocr = join(dir, "ocr.swift");
    writeFileSync(src, "v1");
    writeFileSync(ocr, "// ocr");
    const file = { where: "shot.png", data: Buffer.from("not-a-real-png") };
    const [cachePath] = computeReaderCachePaths([file], dir, [src]);
    const refused: string[] = [];
    const missing: string[] = [];
    const scanner = new BinaryContentScanner(
      dir,
      (where, entry, message) => refused.push(`${where}|${entry}|${message}`),
      (where, entry, message) => missing.push(`${where}|${entry}|${message}`),
    );
    withIsolatedPath(dir, () => {
      const texts = scanner.scanAll([file], [src], ocr);
      expect(texts.has("shot.png")).toBe(false);
    });
    expect(refused).toEqual([]);
    expect(missing).toEqual([
      "shot.png||image not read: not a decodable image, or no OCR here (macOS only)",
    ]);
    expect(existsSync(cachePath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BinaryContentScanner collects OCR text and caches the read result when OCR succeeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "bin-img-ocr-"));
  try {
    const src = join(dir, "reader.ts");
    const ocr = join(dir, "ocr.swift");
    writeFileSync(src, "v1");
    writeFileSync(ocr, "// ocr");
    setupOcrStub(dir, ocr, "Detected slide text");
    const file = { where: "shot.png", data: Buffer.from("fake-png") };
    const [cachePath] = computeReaderCachePaths([file], dir, [src]);
    const refused: string[] = [];
    const missing: string[] = [];
    const scanner = new BinaryContentScanner(
      dir,
      (where, entry, message) => refused.push(`${where}|${entry}|${message}`),
      (where, entry, message) => missing.push(`${where}|${entry}|${message}`),
    );
    const texts = scanner.scanAll([file], [src], ocr);
    expect(texts.get("shot.png")).toContain("Detected slide text");
    expect(refused).toEqual([]);
    expect(missing).toEqual([]);
    expect(existsSync(cachePath)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BinaryContentScanner marks a PDF unread without caching when pdftotext is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "bin-pdf-notext-"));
  try {
    const src = join(dir, "reader.ts");
    const ocr = join(dir, "ocr.swift");
    writeFileSync(src, "v1");
    writeFileSync(ocr, "// ocr");
    const file = { where: "deck.pdf", data: Buffer.from("%PDF-1.4\n") };
    const [cachePath] = computeReaderCachePaths([file], dir, [src]);
    const refused: string[] = [];
    const missing: string[] = [];
    const scanner = new BinaryContentScanner(
      dir,
      (where, entry, message) => refused.push(`${where}|${entry}|${message}`),
      (where, entry, message) => missing.push(`${where}|${entry}|${message}`),
    );
    withIsolatedPath(dir, () => {
      scanner.scanAll([file], [src], ocr);
    });
    expect(refused).toEqual([]);
    expect(missing).toEqual(["deck.pdf||PDF not read: install poppler for pdftotext"]);
    expect(existsSync(cachePath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BinaryContentScanner skips read cache when a PDF has page 1 text but fails to render page 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "bin-pdf-partial-"));
  try {
    const src = join(dir, "reader.ts");
    const ocr = join(dir, "ocr.swift");
    writeFileSync(src, "v1");
    writeFileSync(ocr, "// ocr");
    writeExecutableStub(join(dir, "pdftotext"), "#!/bin/sh\nprintf 'Page one text\\f\\f'\n");
    writeExecutableStub(join(dir, "pdfimages"), "#!/bin/sh\nprintf 'page num\\n---- ---\\n'\n");
    const file = { where: "scan.pdf", data: Buffer.from("%PDF-1.4\n") };
    const [cachePath] = computeReaderCachePaths([file], dir, [src]);
    const refused: string[] = [];
    const missing: string[] = [];
    const scanner = new BinaryContentScanner(
      dir,
      (where, entry, message) => refused.push(`${where}|${entry}|${message}`),
      (where, entry, message) => missing.push(`${where}|${entry}|${message}`),
    );
    withIsolatedPath(dir, () => {
      const texts = scanner.scanAll([file], [src], ocr);
      expect(texts.get("scan.pdf")).toContain("Page one text");
    });
    expect(refused).toEqual([]);
    expect(missing).toEqual([
      "scan.pdf||PDF page 2 holds a scan or an image and was not rendered: install poppler for pdftoppm",
    ]);
    expect(existsSync(cachePath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BinaryContentScanner renders a PDF image page through OCR and caches the result", () => {
  const dir = mkdtempSync(join(tmpdir(), "bin-pdf-ocr-"));
  try {
    const src = join(dir, "reader.ts");
    const ocr = join(dir, "ocr.swift");
    writeFileSync(src, "v1");
    writeFileSync(ocr, "// ocr");
    setupOcrStub(dir, ocr, "Scanned chart text");
    writeExecutableStub(join(dir, "pdftotext"), "#!/bin/sh\nprintf 'Page one text\\f'\n");
    writeExecutableStub(
      join(dir, "pdfimages"),
      "#!/bin/sh\nprintf 'page num type\\n---- --- ----\\n   1   0 image\\n'\n",
    );
    writeExecutableStub(
      join(dir, "pdftoppm"),
      '#!/bin/sh\nfor last; do :; done\n: > "$last.png"\n',
    );
    const file = { where: "chart.pdf", data: Buffer.from("%PDF-1.4\n") };
    const [cachePath] = computeReaderCachePaths([file], dir, [src]);
    const missing: string[] = [];
    const scanner = new BinaryContentScanner(
      dir,
      (where, entry, message) => missing.push(`${where}|${entry}|${message}`),
      (where, entry, message) => missing.push(`${where}|${entry}|${message}`),
    );
    withIsolatedPath(dir, () => {
      const texts = scanner.scanAll([file], [src], ocr);
      expect(texts.get("chart.pdf")).toContain("Page one text");
      expect(texts.get("chart.pdf")).toContain("Scanned chart text");
    });
    expect(missing).toEqual([]);
    expect(existsSync(cachePath)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
