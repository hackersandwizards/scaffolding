#!/usr/bin/env bun
// Keeps company data out of a public repository. Holds no name: it reads a salted hash list kept
// outside the repository.
//   check-leaks --staged                 pre-commit: added lines, images and PDFs in the index
//   check-leaks --message-file <file>    commit-msg: the commit message
//   check-leaks --commit <rev>           one commit: its added lines, images, PDFs and message
//   check-leaks --tree <rev>             every file of a tree, for an audit
//   check-leaks prepush                  pre-push: refuses commits listed in .leak-purged.json,
//                                        then hands the refs to `git lfs pre-push` where LFS is used
//   check-leaks build <names.txt>        prints a hashed list from one name per line
//   check-leaks purged <sha>...          prints .leak-purged.json for commits purged from history
// The list comes from --list <file>, $SCAFFOLDING_LEAK_LIST or ~/.config/scaffolding/leak-list.json.
// Without one, only paths and Company OS screenshot markers are checked. A repository whose
// package.json sets `scaffolding.private: true` is not checked.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { applyAllow, finish, git, readPackage, repoRoot, type Finding } from "../lib/repo.ts";

const started = performance.now();
const argv = process.argv.slice(2);
const arg = (flag: string) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const hasher = (salt: string) => (s: string) =>
  createHash("sha256")
    .update(salt + s)
    .digest("hex")
    .slice(0, 32);
const words = (s: string) => s.match(/[\p{L}\p{N}]+/gu) ?? [];

if (argv[0] === "build") {
  const names = readFileSync(argv[1], "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const dictFile = "/usr/share/dict/words";
  const dict = new Set(
    existsSync(dictFile) ? readFileSync(dictFile, "utf8").toLowerCase().split("\n") : [],
  );
  const salt = randomBytes(16).toString("hex");
  const h = hasher(salt);
  const hashes = new Set<string>();
  let maxTokens = 1;
  const LEGAL = /\s+(?:gmbh|ag|se|kg|ug|mbh|co|ltd|inc|llc|plc|bv|sa|sarl|gmbh & co\.? kg)\.?$/i;
  for (const name of names.flatMap((n) => (LEGAL.test(n) ? [n, n.replace(LEGAL, "")] : [n]))) {
    const tokens = words(name);
    const norm = tokens.join(" ").toLowerCase();
    if (norm.length < 3 || (tokens.length === 1 && norm.length > 3 && dict.has(norm))) continue;
    // A three-letter name is matched case-sensitive: the brand in capitals, not the word.
    hashes.add(norm.length === 3 ? h(`cs:${tokens[0]}`) : h(norm));
    maxTokens = Math.max(maxTokens, Math.min(tokens.length, 6));
  }
  console.log(JSON.stringify({ salt, maxTokens, hashes: [...hashes].sort() }));
  process.exit(0);
}

if (argv[0] === "purged") {
  const salt = randomBytes(16).toString("hex");
  const h = hasher(salt);
  console.log(JSON.stringify({ salt, hashes: argv.slice(1).map(h).sort() }));
  process.exit(0);
}

const root = repoRoot();
const findings: Finding[] = [];
const report = (path: string, text: string, message: string) =>
  findings.push({ check: "leaks", path, text, message });

if (argv[0] === "prepush") {
  const input = readFileSync(0);
  const file = join(root, ".leak-purged.json");
  if (existsSync(file)) {
    const purged = JSON.parse(readFileSync(file, "utf8"));
    const bad = new Set<string>(purged.hashes);
    const h = hasher(purged.salt);
    for (const line of input.toString().split("\n").filter(Boolean)) {
      const local = line.split(" ")[1];
      if (/^0+$/.test(local)) continue;
      const fresh = git(["rev-list", local, "--not", "--remotes"], root).toString().split("\n");
      for (const c of fresh.filter(Boolean))
        if (bad.has(h(c)))
          report(
            "push",
            c,
            "commit purged from this repository's history: clone again and carry your own work over by hand",
          );
    }
  }
  if (findings.length) finish("check-leaks", findings, started);
  const attributes = join(root, ".gitattributes");
  if (existsSync(attributes) && readFileSync(attributes, "utf8").includes("filter=lfs")) {
    const lfs = spawnSync("git", ["lfs", "pre-push", ...argv.slice(1)], {
      input,
      stdio: ["pipe", "inherit", "inherit"],
    });
    process.exit(lfs.status ?? 1);
  }
  process.exit(0);
}

if (readPackage(root).scaffolding?.private === true) process.exit(0);

const listFile =
  arg("--list") ??
  process.env.SCAFFOLDING_LEAK_LIST ??
  join(homedir(), ".config/scaffolding/leak-list.json");
const list = existsSync(listFile) ? JSON.parse(readFileSync(listFile, "utf8")) : undefined;
if (!list)
  console.error(`[check-leaks] no name list at ${listFile}: paths and screenshot markers only`);
const bad = new Set<string>(list?.hashes ?? []);
const h = hasher(list?.salt ?? "");

function scanText(where: string, text: string) {
  if (!list) return;
  const found = new Set<string>();
  const tokens = words(text);
  const lower = tokens.map((w) => w.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].length === 3 && bad.has(h(`cs:${tokens[i]}`))) found.add(tokens[i]);
    let gram = "";
    for (let n = 0; n < list.maxTokens && i + n < tokens.length; n++) {
      gram = n ? `${gram} ${lower[i + n]}` : lower[i];
      if (gram.length > 3 && bad.has(h(gram))) found.add(tokens.slice(i, i + n + 1).join(" "));
    }
  }
  for (const name of found) report(where, name, "name from the company records");
}

const IMAGE = /\.(?:png|jpe?g|webp|gif|heic|tiff?)$/i;
const OS_NAV = ["Dashboard", "Deals", "Deliverables", "Assignments", "Invoices"];

function ocrBinary(): string | undefined {
  const source = join(import.meta.dir, "../lib/ocr.swift");
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 12);
  const bin = join(homedir(), ".cache/scaffolding", `ocr-${digest}`);
  if (existsSync(bin)) return bin;
  if (process.platform !== "darwin") return undefined;
  mkdirSync(join(homedir(), ".cache/scaffolding"), { recursive: true });
  const built = spawnSync("swiftc", ["-O", source, "-o", bin], { stdio: "ignore" });
  return built.status === 0 ? bin : undefined;
}

function scanBinaries(files: { where: string; data: Buffer }[]) {
  if (!files.length) return;
  const scratch = mkdtempSync(join(tmpdir(), "check-leaks-"));
  const texts = new Map<string, string>();
  const images: string[] = [];
  files.forEach(({ where, data }, i) => {
    if (/(?:^|\/)docs\/tracking\//.test(where)) report(where, "", "image or PDF in docs/tracking");
    const file = join(scratch, `${i}${where.match(/\.\w+$/)?.[0] ?? ""}`);
    writeFileSync(file, data);
    if (/\.pdf$/i.test(where))
      texts.set(where, spawnSync("pdftotext", [file, "-"]).stdout?.toString() ?? "");
    else images.push(file);
  });
  const ocr = images.length ? ocrBinary() : undefined;
  if (images.length && !ocr)
    console.error(`[check-leaks] no OCR on this machine: ${images.length} images not read`);
  if (ocr && images.length) {
    const out = spawnSync(ocr, images, { maxBuffer: Infinity }).stdout?.toString() ?? "";
    for (const block of out.split(/^== /m).filter(Boolean)) {
      const [path, ...lines] = block.split("\n");
      texts.set(
        files[Number(path.slice(scratch.length + 1).split(".")[0])].where,
        lines.join("\n"),
      );
    }
  }
  rmSync(scratch, { recursive: true, force: true });
  for (const [where, text] of texts) {
    const nav = OS_NAV.filter((w) => new RegExp(`^${w}$`, "m").test(text));
    if (nav.length >= 3) report(where, nav.join(", "), "Company OS screenshot");
    scanText(where, text);
  }
}

/** Added lines per path from a unified diff with no context. */
function addedLines(diff: string) {
  const added = new Map<string, string[]>();
  let path = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) path = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("+") && path)
      added.set(path, [...(added.get(path) ?? []), line.slice(1)]);
  }
  return added;
}

const isBinary = (p: string) => IMAGE.test(p) || /\.pdf$/i.test(p);
const LFS = "version https://git-lfs";
const blob = (spec: string) => git(["show", spec], root);
const binaries: { where: string; data: Buffer }[] = [];
const take = (where: string, data: Buffer) => {
  if (data.subarray(0, LFS.length).toString() === LFS) {
    if (argv.includes("--staged") && existsSync(join(root, where)))
      data = readFileSync(join(root, where));
    else return console.error(`[check-leaks] ${where}: Git LFS pointer, not read`);
  }
  binaries.push({ where, data });
};

const message = arg("--message-file");
const commit = arg("--commit");
const tree = arg("--tree");
if (message) scanText("commit message", readFileSync(message, "utf8").replace(/^#.*$/gm, ""));
else if (argv.includes("--staged") || commit) {
  const range = commit
    ? ["show", "--format=", "--no-renames", commit]
    : ["diff", "--cached", "--no-renames"];
  const diff = git(
    [...range, "-U0", "--no-color", "--no-ext-diff", "--diff-filter=AM"],
    root,
  ).toString();
  for (const [path, lines] of addedLines(diff))
    if (!isBinary(path)) scanText(path, lines.join("\n"));
  const names = git([...range, "--name-only", "--diff-filter=AM", "-z"], root)
    .toString()
    .split("\0");
  for (const path of names.filter((p) => p && isBinary(p)))
    take(path, blob(commit ? `${commit}:${path}` : `:${path}`));
  if (commit)
    scanText("commit message", git(["log", "-1", "--format=%B", commit], root).toString());
} else if (tree) {
  for (const path of git(["ls-tree", "-r", "--name-only", "-z", tree], root)
    .toString()
    .split("\0")
    .filter(Boolean)) {
    const data = blob(`${tree}:${path}`);
    if (isBinary(path)) take(path, data);
    else if (!data.includes(0)) scanText(path, data.toString("utf8"));
  }
} else {
  console.error(
    "usage: check-leaks --staged | --message-file <file> | --commit <rev> | --tree <rev> | prepush | build <names.txt> | purged <sha>...",
  );
  process.exit(2);
}
scanBinaries(binaries);

finish("check-leaks", applyAllow(root, "leaks", findings, false), started);
