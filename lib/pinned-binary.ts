import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BinaryRelease, PinnedAsset } from "./pinned-binary-assets.ts";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function pinnedBinaryScratch(cache: string, kind: "download" | "staged") {
  return mkdtempSync(join(cache, `${kind}-${process.pid}-`));
}

function removeAbandoned(cache: string) {
  for (const entry of readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const owner = /^(?:download|staged)-([1-9][0-9]*)-[A-Za-z0-9]{6}$/.exec(entry.name)?.[1];
    if (!owner) continue;
    try {
      process.kill(Number(owner), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH")
        rmSync(join(cache, entry.name), { recursive: true, force: true });
    }
  }
}

export async function downloadPinnedAsset(url: string, checksum: string) {
  const response = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (sha256(archive) !== checksum) throw new Error("archive checksum mismatch");
  return archive;
}

type Extraction = {
  tool: string;
  label: string;
  asset: PinnedAsset;
};

export function extractPinnedBinary(scratch: string, archive: Buffer, extraction: Extraction) {
  const {
    tool,
    asset: [, archiveHash, member, checksum = archiveHash],
  } = extraction;
  const candidate = join(scratch, tool);
  if (member) unpackPinnedMember(scratch, archive, extraction);
  else writeFileSync(candidate, archive, { mode: 0o600, flag: "wx" });
  if (sha256(readFileSync(candidate)) !== checksum) throw new Error("binary checksum mismatch");
  chmodSync(candidate, 0o755);
  return candidate;
}

function unpackPinnedMember(scratch: string, archive: Buffer, extraction: Extraction) {
  // Stream only the named member so the extractor never writes archive paths or permissions.
  const {
    tool,
    label,
    asset: [archiveName, , member],
  } = extraction;
  if (!member) throw new Error("missing archive member");
  writeFileSync(join(scratch, archiveName), archive, { mode: 0o600, flag: "wx" });
  const candidate = join(scratch, tool);
  const [command, ...args] = archiveName.endsWith(".zip")
    ? ["unzip", "-p", archiveName, member]
    : ["tar", "-xOzf", archiveName, member];
  const output = openSync(candidate, "wx", 0o600);
  let unpacked;
  try {
    unpacked = spawnSync(command, args, {
      cwd: scratch,
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", output, "pipe"],
    });
  } finally {
    closeSync(output);
  }
  if (unpacked.status !== 0)
    throw new Error(
      `${command} could not extract the ${label} binary: ${unpacked.error?.message ?? unpacked.stderr?.toString().trim() ?? "unknown error"}`,
    );
}

export async function pinnedBinary(
  root: string,
  tool: string,
  pin: BinaryRelease,
): Promise<string> {
  const { label, release, base, assets } = pin;
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const target = `${process.platform}.${arch}`;
  const asset = assets.get(target);
  if (!asset) throw new Error(`no pinned ${label} ${release} asset for ${target}`);

  const cache = scaffoldingCache(root, [tool, release], label);
  removeAbandoned(cache);
  const binary = join(cache, tool);
  const found = lstatSync(binary, { throwIfNoEntry: false });
  if (found) {
    if (!found.isFile()) throw new Error(`${label} cache binary must be a regular file`);
    if (sha256(readFileSync(binary)) !== (asset[3] ?? asset[1]))
      throw new Error(`cached ${label} ${release} binary checksum mismatch: ${binary}`);
    return binary;
  }

  const scratch = pinnedBinaryScratch(cache, "download");
  try {
    const archive = await downloadPinnedAsset(`${base}/${asset[0]}`, asset[1]);
    const candidate = extractPinnedBinary(scratch, archive, { tool, label, asset });
    renameSync(candidate, binary);
    return binary;
  } catch (error) {
    throw new Error(
      `could not download ${label} ${release} for ${target}: ${(error as Error).message.replace(/\s+/g, " ")}`,
      { cause: error },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function scaffoldingCache(root: string, dirs: string[], label: string) {
  let cache = root;
  for (const dir of ["node_modules", ".cache", "scaffolding", ...dirs]) {
    cache = join(cache, dir);
    mkdirSync(cache, { recursive: true });
    if (!lstatSync(cache).isDirectory()) throw new Error(`${label} cache contains a symlink`);
  }
  return cache;
}
