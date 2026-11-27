import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { decodeEntities } from "./confidential-input.ts";

export const IMAGE_PATTERN = /\.(?:png|jpe?g|webp|gif|heic|heif|avif|tiff?|bmp|ico|icns)$/i;
export const LFS_OID_PATTERN = /^oid sha256:([0-9a-f]{64})$/m;

export type ZipEntry = { name: string; data: Buffer };
export type LfsPointer = { oid: string; size: number };

// Glyph outlines, no text a scan could read, known by their own signature: WOFF, WOFF2, OpenType,
// TrueType and a collection at the start, EOT's at byte 34. An Office file's embedded font is
// obfuscated, so there the name alone tells.
const FONT_SIGNATURES = ["wOFF", "wOF2", "OTTO", "\0\x01\0\0", "true", "ttcf"];
const XML_PATTERN = /\.(?:xml|rels|x?html?|svg)$/i;
// Paragraphs, breaks, cells and list items of Office, OpenDocument and HTML markup.
const BLOCK_TAGS = /<\/?(?:\w+:)?(?:p|h\d?|br|tab|tc|td|th|tr|si|c|li|div|line-break)\b[^>]*>/g;
const OS_NAV = ["Dashboard", "Deals", "Deliverables", "Assignments", "Invoices"];
// A pointer is all a blob holds, so a text that only starts like one is still read as text.
const LFS_POINTER_PATTERN =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:ext-[^\n]*\n)*oid sha256:[0-9a-f]{64}\nsize \d+\n?$/;

export function isBinaryExtension(path: string): boolean {
  return IMAGE_PATTERN.test(path) || /\.pdf$/i.test(path);
}

export function isFontBuffer(name: string, data: Buffer, depth: number): boolean {
  return (
    FONT_SIGNATURES.includes(data.subarray(0, 4).toString("latin1")) ||
    data.subarray(34, 36).toString("latin1") === "LP" ||
    (depth > 0 && /\.odttf$/i.test(name))
  );
}

// Markup read twice: a block's tag as a line break and every other tag dropped joins a word
// Word splits across runs; every tag as a space keeps apart what no block tag separates.
export function extractMarkupText(name: string, text: string): string {
  if (!XML_PATTERN.test(name) && !text.startsWith("<?xml")) return text;
  const spaced = text.replace(/<[^>]*>/g, " ");
  const blocked = text.replace(BLOCK_TAGS, "\n").replace(/<[^>]*>/g, "");
  return decodeEntities(`${spaced}\n${blocked}`);
}

const DAMAGED_ZIP = "damaged zip archive";

function zipDirectoryEntry(data: Buffer, offset: number) {
  if (offset + 46 > data.length) return DAMAGED_ZIP;
  if (data.readUInt32LE(offset) !== 0x02014b50) return "damaged zip directory";
  const nameStart = offset + 46;
  const nameEnd = nameStart + data.readUInt16LE(offset + 28);
  const next = nameEnd + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
  if (next > data.length) return DAMAGED_ZIP;
  return {
    name: data.toString("utf8", nameStart, nameEnd),
    flags: data.readUInt16LE(offset + 8),
    method: data.readUInt16LE(offset + 10),
    size: data.readUInt32LE(offset + 20),
    local: data.readUInt32LE(offset + 42),
    next,
  };
}

function inflateZipBody(raw: Buffer): Buffer | string {
  try {
    return inflateRawSync(raw);
  } catch (error) {
    if (error instanceof Error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR")
        return `${DAMAGED_ZIP} (${error.message})`;
    }
    throw error;
  }
}

function zipEntryBody(data: Buffer, entry: Exclude<ReturnType<typeof zipDirectoryEntry>, string>) {
  const { name, flags, method, size, local } = entry;
  if (flags & 1) return `${name} is encrypted`;
  if (size === 0xffffffff || local === 0xffffffff) return "zip64 archive";
  if (local + 30 > data.length) return DAMAGED_ZIP;
  const from = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
  if (from + size > data.length) return DAMAGED_ZIP;
  const raw = data.subarray(from, from + size);
  if (method === 0) return raw;
  if (method === 8) return inflateZipBody(raw);
  return `${name} uses compression method ${method}`;
}

/** The entries of a zip archive (Office, OpenDocument, iWork, .zip), or why it cannot be read. */
export function unzipArchive(data: Buffer): ZipEntry[] | string {
  const end = data.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
  if (end < 0) return "no zip directory";
  if (end + 22 > data.length) return DAMAGED_ZIP;
  const entries: ZipEntry[] = [];
  let offset = data.readUInt32LE(end + 16);
  for (let n = data.readUInt16LE(end + 10); n > 0; n--) {
    const entry = zipDirectoryEntry(data, offset);
    if (typeof entry === "string") return entry;
    offset = entry.next;
    if (entry.name.endsWith("/")) continue;
    const contents = zipEntryBody(data, entry);
    if (typeof contents === "string") return contents;
    entries.push({ name: entry.name, data: contents });
  }
  return entries;
}

// "page num type width ..." under two header lines, one row per image.
export function parsePdfImagePages(pdfImagesOutput: string): Set<number> {
  return new Set(
    pdfImagesOutput
      .split("\n")
      .slice(2)
      .map((row) => Number(row.trim().split(/\s+/)[0])),
  );
}

// A recognised line may itself start "== ": only a scratch path opens a block.
export function parseOcrBlocks(stdout: string, scratchDir: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const block of `\n${stdout}`.split(`\n== ${scratchDir}/`).slice(1)) {
    const [file, ...lines] = block.split("\n");
    blocks.set(join(scratchDir, file), lines.join("\n"));
  }
  return blocks;
}

export function detectCompanyOsNav(text: string): string[] {
  return OS_NAV.filter((word) => new RegExp(`^${word}$`, "m").test(text));
}

export function isLfsPointer(data: Buffer): boolean {
  return data.length < 1024 && LFS_POINTER_PATTERN.test(data.toString());
}

export function parseLfsPointer(pointer: Buffer): LfsPointer | undefined {
  const text = pointer.toString();
  const oid = LFS_OID_PATTERN.exec(text)?.[1];
  const size = Number(/^size (\d+)$/m.exec(text)?.[1]);
  if (!oid || !Number.isFinite(size)) return undefined;
  return { oid, size };
}

export function readLfsContent(
  candidatePaths: readonly string[],
  pointer: LfsPointer,
): Buffer | undefined {
  for (const file of candidatePaths) {
    const found = statSync(file, { throwIfNoEntry: false });
    if (!found?.isFile() || found.size !== pointer.size) continue;
    const data = readFileSync(file);
    if (createHash("sha256").update(data).digest("hex") === pointer.oid) return data;
  }
  return undefined;
}
