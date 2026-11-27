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
  const response = await fetch(url, {
    credentials: "omit",
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => {
    throw new Error(
      `The check could not reach the release URL (${(error as Error).message}). Check network access and rerun the check.`,
      { cause: error },
    );
  });
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status} blocked the release download. Check access to the release URL and rerun the check.`,
    );
  const archive = Buffer.from(await response.arrayBuffer());
  if (sha256(archive) !== checksum)
    throw new Error(
      "The archive checksum does not match the pin, so the check rejected the download. Rerun the check on a trusted connection and report a persistent mismatch to the scaffolding maintainer.",
    );
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
  if (sha256(readFileSync(candidate)) !== checksum)
    throw new Error(
      "The binary checksum does not match the pin, so the check rejected the executable. Rerun the check and report a persistent mismatch to the scaffolding maintainer.",
    );
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
      `${command} could not extract the ${label} binary (${unpacked.error?.message ?? unpacked.stderr?.toString().trim() ?? "unknown error"}). Check that ${command} is available in /usr/bin or /bin and use the error to fix the extraction failure.`,
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
  if (!asset)
    throw new Error(
      `No pinned ${label} ${release} asset for ${target}, so the check cannot run here. Run it on macOS or Linux on arm64 or x86-64.`,
    );

  const cache = scaffoldingCache(root, [tool, release], label);
  removeAbandoned(cache);
  const binary = join(cache, tool);
  const found = lstatSync(binary, { throwIfNoEntry: false });
  if (found) {
    if (!found.isFile())
      throw new Error(
        `The ${label} cache binary at ${binary} must be a regular file before it can be verified. Remove that cache entry and rerun the check to download it again.`,
      );
    if (sha256(readFileSync(binary)) !== (asset[3] ?? asset[1]))
      throw new Error(
        `The cached ${label} ${release} binary at ${binary} failed its checksum check. Remove that file and rerun the check to download a verified copy.`,
      );
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
    if (!lstatSync(cache).isDirectory())
      throw new Error(
        `The ${label} cache path ${cache} cannot be used because it is a symlink. Replace the link with a real directory and rerun the check.`,
      );
  }
  return cache;
}
