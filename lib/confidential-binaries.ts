import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import {
  extractMarkupText,
  IMAGE_PATTERN,
  isFontBuffer,
  parseOcrBlocks,
  parsePdfImagePages,
  unzipArchive,
} from "./confidential-archive.ts";
import type { Finding } from "./repo.ts";

export type BinaryFile = { where: string; data: Buffer };
export type BinaryReportHandler = (where: string, entry: string, message: string) => void;
type PendingImage = { file: string; where: string; entry: string; why: string };

// A review page's images may sit under docs/agent-work once read clean. A CI audit reads none, so
// there they stay refused rather than pass unread.
export function agentWorkCiFindings(files: readonly BinaryFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const { where } of files) {
    if (/(?:^|\/)docs\/agent-work\//.test(where)) {
      findings.push({
        check: "confidential",
        path: where,
        text: "",
        message:
          "binary file in docs/agent-work not read: no OCR in CI. Remove the binary from docs/agent-work/ or replace it with Markdown/text; only if it must live in this public repo, verify it locally on macOS and add an entry with a reason in package.json scaffolding.allow",
      });
    }
  }
  return findings;
}

export function compileOcrBinary(ocrSource: string, cacheDir: string): string | undefined {
  const digest = createHash("sha256").update(readFileSync(ocrSource)).digest("hex").slice(0, 12);
  const bin = join(cacheDir, `ocr-${digest}`);
  if (existsSync(bin)) return bin;
  if (process.platform !== "darwin") return undefined;
  const built = spawnSync("swiftc", ["-O", ocrSource, "-o", bin], { stdio: "ignore" });
  return built.status === 0 ? bin : undefined;
}

export function computeReaderCachePaths(
  files: readonly BinaryFile[],
  cacheDir: string,
  sourcePaths: readonly string[],
): string[] {
  const reader = createHash("sha256").update("reader-cache-v2\0");
  for (const source of sourcePaths) reader.update(readFileSync(source)).update("\0");
  return files.map(({ where, data }) => {
    const digest = reader.copy().update(where).update("\0").update(data).digest("hex");
    return join(cacheDir, "read", digest.slice(0, 32));
  });
}

class FileContentReader {
  private readonly scanner: BinaryContentScanner;
  private readonly where: string;

  constructor(scanner: BinaryContentScanner, where: string) {
    this.scanner = scanner;
    this.where = where;
  }

  // `name` is the file's own name, inside an archive the entry's; findings name `where`.
  read(name: string, data: Buffer, depth = 0): void {
    const entry = name === this.where ? "" : name;
    if (/\.pdf$/i.test(name) || data.subarray(0, 5).toString() === "%PDF-")
      this.readPdf(entry, data);
    else if (IMAGE_PATTERN.test(name)) this.queueImage(entry, name, data);
    else if (data.subarray(0, 4).toString("latin1") === "PK\x03\x04" && depth < 3)
      this.readArchive(entry, data, depth);
    else if (!data.includes(0))
      this.scanner.appendText(this.where, extractMarkupText(name, data.toString("utf8")));
    else if (!isFontBuffer(name, data, depth))
      this.scanner.refuse(
        this.where,
        entry,
        "binary file not read: remove the binary or replace it with a text or scannable format so confidential terms cannot slip into this public repository. Only if the binary genuinely belongs here and contains no confidential data, add an entry with a reason in package.json scaffolding.allow",
      );
  }

  private queueImage(entry: string, name: string, data: Buffer): void {
    this.scanner.addImage({
      file: this.scanner.saveScratchFile(data, name),
      where: this.where,
      entry,
      why: "Image text could not be scanned because the file could not be decoded or OCR was unavailable. Replace the image with a readable export and rerun the scan on macOS.",
    });
  }

  private readArchive(entry: string, data: Buffer, depth: number): void {
    const entries = unzipArchive(data);
    if (typeof entries === "string") {
      this.scanner.refuse(
        this.where,
        entry,
        `archive not read: ${entries}. Replace the damaged, encrypted, or unsupported archive with plain files or a standard unencrypted ZIP (stored/deflate) so its contents can be scanned, or remove it from the repository`,
      );
      return;
    }
    this.scanner.appendText(this.where, entries.map((item) => item.name).join("\n"));
    for (const item of entries) this.read(item.name, item.data, depth + 1);
  }

  private readPdf(entry: string, data: Buffer): void {
    const file = this.scanner.saveScratchFile(data, "x.pdf");
    const pdf = spawnSync("pdftotext", [file, "-"], { maxBuffer: Infinity });
    if (pdf.status !== 0) {
      this.scanner.markToolMissing(
        this.where,
        entry,
        "PDF not read: install poppler for pdftotext",
      );
      return;
    }
    const pages = pdf.stdout.toString().split("\f").slice(0, -1);
    this.scanner.appendText(this.where, pages.join("\n"));
    const listed = spawnSync("pdfimages", ["-list", file]);
    if (listed.status !== 0) {
      this.scanner.markToolMissing(
        this.where,
        entry,
        "PDF not read: install poppler for pdfimages",
      );
      return;
    }
    const pictured = parsePdfImagePages(listed.stdout.toString());
    pages.forEach((page, index) => {
      if (/[\p{L}\p{N}]/u.test(page) && !pictured.has(index + 1)) return;
      this.renderPdfPage(file, index + 1, entry);
    });
  }

  private renderPdfPage(file: string, pageNumber: number, entry: string): void {
    const out = `${file}-${pageNumber}`;
    const rendered = spawnSync("pdftoppm", [
      "-r",
      "150",
      "-png",
      "-singlefile",
      "-f",
      `${pageNumber}`,
      "-l",
      `${pageNumber}`,
      file,
      out,
    ]);
    if (rendered.status !== 0) {
      this.scanner.markToolMissing(
        this.where,
        entry,
        `PDF page ${pageNumber} holds a scan or an image and was not rendered: install poppler for pdftoppm`,
      );
      return;
    }
    this.scanner.addImage({
      file: `${out}.png`,
      where: this.where,
      entry,
      why: `PDF page ${pageNumber} holds a scan or an image whose text OCR could not read. Rerun the scan on macOS and re-export the PDF if that page still cannot be read.`,
    });
  }
}

export class BinaryContentScanner {
  private readonly cacheDir: string;
  private readonly onRefuse: BinaryReportHandler;
  private readonly onMissingTool: BinaryReportHandler;
  private readonly texts = new Map<string, string>();
  private readonly images: PendingImage[] = [];
  // Only a file read whole is kept as read: one not read is tried again.
  private readonly unread = new Set<string>();
  private scratch = "";
  private saved = 0;

  constructor(cacheDir: string, onRefuse: BinaryReportHandler, onMissingTool: BinaryReportHandler) {
    this.cacheDir = cacheDir;
    this.onRefuse = onRefuse;
    this.onMissingTool = onMissingTool;
  }

  appendText(where: string, text: string): void {
    this.texts.set(where, `${this.texts.get(where) ?? ""}\n${text}`);
  }

  refuse(where: string, entry: string, message: string): void {
    this.unread.add(where);
    this.onRefuse(where, entry, message);
  }

  markToolMissing(where: string, entry: string, message: string): void {
    this.unread.add(where);
    this.onMissingTool(where, entry, message);
  }

  addImage(image: PendingImage): void {
    this.images.push(image);
  }

  saveScratchFile(data: Buffer, name: string): string {
    const file = join(this.scratch, `${this.saved++}${extname(name)}`);
    writeFileSync(file, data);
    return file;
  }

  scanAll(
    files: readonly BinaryFile[],
    readerSources: readonly string[],
    ocrSource: string,
  ): Map<string, string> {
    mkdirSync(this.cacheDir, { recursive: true });
    this.scratch = mkdtempSync(join(this.cacheDir, "scan-"));
    try {
      const kept = computeReaderCachePaths(files, this.cacheDir, readerSources);
      files.forEach(({ where, data }, index) =>
        existsSync(kept[index])
          ? this.appendText(where, readFileSync(kept[index], "utf8"))
          : new FileContentReader(this, where).read(where, data),
      );
      this.applyOcr(ocrSource);
      this.writeReadCache(files, kept);
      return this.texts;
    } finally {
      rmSync(this.scratch, { recursive: true, force: true });
    }
  }

  private applyOcr(ocrSource: string): void {
    const ocr = this.images.length ? compileOcrBinary(ocrSource, this.cacheDir) : undefined;
    const blocks = this.runOcrBinary(ocr);
    for (const { file, where, entry, why } of this.images) {
      const text = blocks.get(file);
      if (text !== undefined) this.appendText(where, text);
      else this.markToolMissing(where, entry, why);
    }
  }

  private runOcrBinary(ocr: string | undefined): Map<string, string> {
    if (!ocr) return new Map<string, string>();
    const out = spawnSync(
      ocr,
      this.images.map((item) => item.file),
      { maxBuffer: Infinity },
    );
    return out.status === 0
      ? parseOcrBlocks(out.stdout.toString(), this.scratch)
      : new Map<string, string>();
  }

  private writeReadCache(files: readonly BinaryFile[], kept: readonly string[]): void {
    mkdirSync(join(this.cacheDir, "read"), { recursive: true });
    files.forEach(({ where }, index) => {
      if (this.unread.has(where) || existsSync(kept[index])) return;
      // Renamed into place, so a killed run leaves no part of a text that later reads as whole.
      writeFileSync(`${kept[index]}.${process.pid}`, this.texts.get(where) ?? "");
      renameSync(`${kept[index]}.${process.pid}`, kept[index]);
    });
  }
}
