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

const release = "v0.11.0";
const assets = new Map([
  [
    "darwin.aarch64",
    {
      archive: "339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f",
      binary: "61c17246d69f012cd458ae82f244c46023dac75d1b69733ca1cc7d28fb270fd7",
    },
  ],
  [
    "darwin.x86_64",
    {
      archive: "c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51",
      binary: "2589be755bb115f4421b8271eb7c08df1e03729f00350c1e4cf53b4a0bf9c2df",
    },
  ],
  [
    "linux.aarch64",
    {
      archive: "68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc",
      binary: "127f13925eadd52c341bca0ebaf9ab0dbd78c6468f30a8f262a528bf8de47546",
    },
  ],
  [
    "linux.x86_64",
    {
      archive: "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6",
      binary: "4da528ddb3a4d1b7b24a59d4e16eb2f5fd960f4bd9a3708a15baddbdf1d5a55b",
    },
  ],
]);

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function shellcheckScratch(cache: string, kind: "download" | "staged") {
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

export async function downloadShellcheckArchive(target: string, checksum: string) {
  const asset = `shellcheck-${release}.${target}.tar.gz`;
  const response = await fetch(
    `https://github.com/koalaman/shellcheck/releases/download/${release}/${asset}`,
    { credentials: "omit", signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (sha256(archive) !== checksum) throw new Error("archive checksum mismatch");
  return archive;
}

export function extractShellcheckBinary(scratch: string, archive: Buffer, checksum: string) {
  // Read only the verified member so tar never sets permissions or writes other archive paths.
  const archiveName = "shellcheck.tar.gz";
  writeFileSync(join(scratch, archiveName), archive, { mode: 0o600, flag: "wx" });
  const candidate = join(scratch, "shellcheck");
  const output = openSync(candidate, "wx", 0o600);
  let unpacked;
  try {
    unpacked = spawnSync("tar", ["-xOzf", archiveName, `shellcheck-${release}/shellcheck`], {
      cwd: scratch,
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", output, "pipe"],
    });
  } finally {
    closeSync(output);
  }
  if (unpacked.status !== 0)
    throw new Error(
      `tar could not extract the ShellCheck binary: ${unpacked.error?.message ?? unpacked.stderr?.toString().trim() ?? "unknown error"}`,
    );
  if (sha256(readFileSync(candidate)) !== checksum) throw new Error("binary checksum mismatch");
  chmodSync(candidate, 0o755);
  return candidate;
}

export async function shellcheckBinary(root: string): Promise<string> {
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const target = `${process.platform}.${arch}`;
  const hashes = assets.get(target);
  if (!hashes) throw new Error(`no pinned ShellCheck ${release} asset for ${target}`);

  let cache = root;
  for (const dir of ["node_modules", ".cache", "scaffolding", "shellcheck", release]) {
    cache = join(cache, dir);
    mkdirSync(cache, { recursive: true });
    if (!lstatSync(cache).isDirectory()) throw new Error("ShellCheck cache contains a symlink");
  }
  removeAbandoned(cache);
  const binary = join(cache, "shellcheck");
  const found = lstatSync(binary, { throwIfNoEntry: false });
  if (found) {
    if (!found.isFile()) throw new Error("ShellCheck cache binary must be a regular file");
    if (sha256(readFileSync(binary)) !== hashes.binary)
      throw new Error(`cached ShellCheck ${release} binary checksum mismatch: ${binary}`);
    return binary;
  }

  const scratch = shellcheckScratch(cache, "download");
  try {
    const archive = await downloadShellcheckArchive(target, hashes.archive);
    const candidate = extractShellcheckBinary(scratch, archive, hashes.binary);
    renameSync(candidate, binary);
    return binary;
  } catch (error) {
    throw new Error(
      `could not download ShellCheck ${release} for ${target}: ${(error as Error).message.replace(/\s+/g, " ")}`,
      { cause: error },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
