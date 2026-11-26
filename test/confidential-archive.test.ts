import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { expect, test } from "vitest";
import {
  detectCompanyOsNav,
  extractMarkupText,
  isBinaryExtension,
  isFontBuffer,
  isLfsPointer,
  parseLfsPointer,
  parseOcrBlocks,
  parsePdfImagePages,
  readLfsContent,
  unzipArchive,
} from "../lib/confidential-archive.ts";

function buildZipBuffer(
  entries: { name: string; content: Buffer; method?: number; flags?: number; zip64?: boolean }[],
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const item of entries) {
    const method = item.method ?? 0;
    const flags = item.flags ?? 0;
    const payload = method === 8 ? deflateRawSync(item.content) : item.content;
    const nameBuf = Buffer.from(item.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(item.content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(item.zip64 ? 0xffffffff : payload.length, 20);
    central.writeUInt32LE(item.content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += 30 + nameBuf.length + payload.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDir, eocd]);
}

test.each([
  { path: "diagram.PNG", expected: true },
  { path: "report.pdf", expected: true },
  { path: "notes.md", expected: false },
])("isBinaryExtension($path) is $expected", ({ path, expected }) => {
  expect(isBinaryExtension(path)).toBe(expected);
});

test.each([
  { label: "woff2 header", name: "a.bin", data: Buffer.from("wOF2rest"), depth: 0, expected: true },
  {
    label: "eot marker",
    name: "a.eot",
    data: Buffer.concat([Buffer.alloc(34), Buffer.from("LP")]),
    depth: 0,
    expected: true,
  },
  { label: "embedded odttf", name: "font.odttf", data: Buffer.alloc(16), depth: 1, expected: true },
  {
    label: "top-level odttf",
    name: "font.odttf",
    data: Buffer.alloc(16),
    depth: 0,
    expected: false,
  },
  {
    label: "plain binary",
    name: "a.bin",
    data: Buffer.from([0, 1, 2, 3]),
    depth: 0,
    expected: false,
  },
])("isFontBuffer: $label", ({ name, data, depth, expected }) => {
  expect(isFontBuffer(name, data, depth)).toBe(expected);
});

test.each([
  { name: "note.txt", text: "plain &amp; text", expected: "plain &amp; text" },
  {
    name: "doc.xml",
    text: "<p>Hel<span>lo</span> &amp; world</p>",
    expected: " Hel lo  & world \n\nHello & world\n",
  },
  {
    name: "raw.dat",
    text: '<?xml version="1.0"?><p>Hi&#33;</p>',
    expected: "  Hi! \n\nHi!\n",
  },
])("extractMarkupText($name)", ({ name, text, expected }) => {
  expect(extractMarkupText(name, text)).toBe(expected);
});

test("unzipArchive reads stored and deflated entries while skipping directories", () => {
  const zip = buildZipBuffer([
    { name: "dir/", content: Buffer.alloc(0) },
    { name: "dir/stored.txt", content: Buffer.from("alpha"), method: 0 },
    { name: "dir/deflated.txt", content: Buffer.from("beta gamma"), method: 8 },
  ]);
  const entries = unzipArchive(zip);
  expect(entries).toEqual([
    { name: "dir/stored.txt", data: Buffer.from("alpha") },
    { name: "dir/deflated.txt", data: Buffer.from("beta gamma") },
  ]);
});

test.each([
  { label: "no directory", data: Buffer.from("not a zip"), expected: "no zip directory" },
  {
    label: "encrypted",
    data: buildZipBuffer([{ name: "secret.txt", content: Buffer.from("x"), flags: 1 }]),
    expected: "secret.txt is encrypted",
  },
  {
    label: "zip64",
    data: buildZipBuffer([{ name: "big.bin", content: Buffer.from("x"), zip64: true }]),
    expected: "zip64 archive",
  },
  {
    label: "unsupported method",
    data: buildZipBuffer([{ name: "x.bin", content: Buffer.from("x"), method: 99 }]),
    expected: "x.bin uses compression method 99",
  },
])("unzipArchive rejects $label", ({ data, expected }) => {
  expect(unzipArchive(data)).toBe(expected);
});

test("parsePdfImagePages parses page numbers after two header lines", () => {
  const output = "page num type\n---\n   2   0 image\n   5   1 image\n";
  expect([...parsePdfImagePages(output)]).toEqual([2, 5, 0]);
});

test("parseOcrBlocks splits only on scratch-prefixed headers", () => {
  const stdout = "== /work/scan/0.png\nHello\n== not a header\n== /work/scan/1.png\nWorld";
  const blocks = parseOcrBlocks(stdout, "/work/scan");
  expect([...blocks.entries()]).toEqual([
    ["/work/scan/0.png", "Hello\n== not a header"],
    ["/work/scan/1.png", "World"],
  ]);
});

test.each([
  { text: "Dashboard\nDeals\nInvoices", expected: ["Dashboard", "Deals", "Invoices"] },
  { text: "My Dashboard\nDeals", expected: ["Deals"] },
])("detectCompanyOsNav finds full-line nav labels", ({ text, expected }) => {
  expect(detectCompanyOsNav(text)).toEqual(expected);
});

const SAMPLE_PAYLOAD = Buffer.from("sample-lfs-binary");
const SAMPLE_OID = createHash("sha256").update(SAMPLE_PAYLOAD).digest("hex");
const SAMPLE_POINTER = Buffer.from(
  `version https://git-lfs.github.com/spec/v1\noid sha256:${SAMPLE_OID}\nsize ${SAMPLE_PAYLOAD.length}\n`,
);

test.each([
  { label: "valid pointer", data: SAMPLE_POINTER, expected: true },
  {
    label: "trailing text",
    data: Buffer.from(`${SAMPLE_POINTER.toString()}extra`),
    expected: false,
  },
])("isLfsPointer: $label", ({ data, expected }) => {
  expect(isLfsPointer(data)).toBe(expected);
});

test.each([
  { data: SAMPLE_POINTER, expected: { oid: SAMPLE_OID, size: SAMPLE_PAYLOAD.length } },
  { data: Buffer.from("plain text"), expected: undefined },
])("parseLfsPointer extracts oid and size", ({ data, expected }) => {
  expect(parseLfsPointer(data)).toEqual(expected);
});

test("readLfsContent returns the first candidate matching both size and sha256", () => {
  const dir = mkdtempSync(join(tmpdir(), "lfs-read-"));
  try {
    const wrongSize = join(dir, "wrong-size");
    const wrongHash = join(dir, "wrong-hash");
    const right = join(dir, "right");
    writeFileSync(wrongSize, Buffer.from("short"));
    writeFileSync(wrongHash, Buffer.from("X".repeat(SAMPLE_PAYLOAD.length)));
    writeFileSync(right, SAMPLE_PAYLOAD);
    const pointer = { oid: SAMPLE_OID, size: SAMPLE_PAYLOAD.length };
    expect(readLfsContent([join(dir, "missing"), wrongSize, wrongHash, right], pointer)).toEqual(
      SAMPLE_PAYLOAD,
    );
    expect(readLfsContent([wrongSize, wrongHash], pointer)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
