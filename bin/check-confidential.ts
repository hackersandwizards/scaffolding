#!/usr/bin/env bun
//   check-confidential --staged               pre-commit: added lines, images and PDFs in the index
//   check-confidential --message-file <file>  commit-msg: the commit message
//   check-confidential --commit <rev>         one commit: its added lines, images, PDFs and message
//   check-confidential --tree <rev>           every file of a tree, for an audit
//   check-confidential prepush                pre-push: refuses commits listed in
//                                             .confidential-purged.json, then hands the refs to
//                                             `git lfs pre-push` where the push may carry LFS content
//                                             or touch a lockable file
//   check-confidential fetch                  fetches the list now, for a cloud setup script
//   check-confidential build <terms|-> [--public <file>]
//                                             prints a hashed list from one term per line (- reads
//                                             stdin), stamped with its build time, leaving out every
//                                             term the public text in <file> already carries
//   check-confidential purged <sha>...        prints .confidential-purged.json for purged commits
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { applyAllow, finish, git, readPackage, repoRoot, type Finding } from "../lib/repo.ts";

const TERMS_REPO = "hackersandwizards/confidential-terms";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
// NFKC first: macOS file names and some pasted text arrive decomposed, which splits words at accents.
const words = (s: string) => s.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
// A one-word term written in capitals is a name in capitals (an acronym, a brand) and matches only
// in capitals, so a company called QUUX never flags an ordinary word "quux". Three-letter terms
// always do.
const SLUG = /[\p{L}\p{N}]+(?:[-_/.][\p{L}\p{N}]+)+/gu;
const capitals = (w: string) => /^\p{Lu}[\p{Lu}\p{N}]+$/u.test(w);

if (argv[0] === "build") {
  const terms = readFileSync(argv[1] === "-" ? 0 : argv[1], "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const dictFile = "/usr/share/dict/words";
  // Without the dictionary every common word on the list would refuse ordinary text everywhere.
  if (!existsSync(dictFile)) {
    console.error(`[check-confidential] no ${dictFile} on this machine: not building`);
    process.exit(1);
  }
  const dict = new Set(readFileSync(dictFile, "utf8").toLowerCase().split("\n"));
  const publicFile = arg("--public");
  const published = new Set<string>();
  if (publicFile) {
    const p = words(readFileSync(publicFile, "utf8")).map((w) => w.toLowerCase());
    for (let i = 0; i < p.length; i++)
      for (let n = 1, gram = p[i]; n <= 6 && i + n <= p.length; gram += ` ${p[i + n]}`, n++)
        published.add(gram);
  }
  const salt = randomBytes(16).toString("hex");
  const h = hasher(salt);
  const hashes = new Set<string>();
  let maxTokens = 1;
  const LEGAL = /\s+(?:gmbh|ag|se|kg|ug|mbh|co|ltd|inc|llc|plc|bv|sa|sarl|gmbh & co\.? kg)\.?$/i;
  const norm = (term: string) => words(term).join(" ").toLowerCase();
  for (const term of terms) {
    const variants = LEGAL.test(term) ? [term, term.replace(LEGAL, "")] : [term];
    if (variants.some((v) => published.has(norm(v)))) continue;
    for (const variant of variants) {
      const tokens = words(variant);
      const n = norm(variant);
      const word = tokens.length === 1 && n.length > 3 && dict.has(n) && !capitals(tokens[0]);
      if (n.length < 3 || word) continue;
      const cased = tokens.length === 1 && (n.length === 3 || capitals(tokens[0]));
      hashes.add(cased ? h(`cs:${tokens[0]}`) : h(n));
      maxTokens = Math.max(maxTokens, Math.min(tokens.length, 6));
    }
  }
  const built = new Date().toISOString();
  console.log(JSON.stringify({ built, salt, maxTokens, hashes: [...hashes].sort() }));
  process.exit(0);
}

if (argv[0] === "purged") {
  const salt = randomBytes(16).toString("hex");
  const h = hasher(salt);
  console.log(JSON.stringify({ salt, hashes: argv.slice(1).map(h).sort() }));
  process.exit(0);
}

const root = repoRoot();
const CACHE_DIR = join(root, "node_modules/.cache/scaffolding");
const CACHE = join(CACHE_DIR, "confidential-terms.json");
const ATTEMPT = `${CACHE}.attempt`;
const findings: Finding[] = [];
const report = (path: string, text: string, message: string) =>
  findings.push({ check: "confidential", path, text, message });

if (argv[0] === "prepush") {
  const input = readFileSync(0);
  const lines = input
    .toString()
    .split("\n")
    .map((line) => line.split(" "));
  const sha = (i: number) => lines.map((l) => l[i]).filter((s) => s && !/^0+$/.test(s));
  const locals = sha(1);
  // New to the remote pushed to: a commit another remote already holds may still be missing there.
  // Its tips from the input cover a push to a URL, which has no tracking refs.
  const notOnRemote = ["--ignore-missing", "--not", `--remotes=${argv[1]}`, ...sha(3)];
  const file = join(root, ".confidential-purged.json");
  if (existsSync(file)) {
    const purged = JSON.parse(readFileSync(file, "utf8"));
    const bad = new Set<string>(purged.hashes);
    const h = hasher(purged.salt);
    const commits = locals.flatMap((local) =>
      git(["rev-list", local, ...notOnRemote], root)
        .toString()
        .split("\n")
        .filter(Boolean),
    );
    for (const c of commits)
      if (bad.has(h(c)))
        report(
          "push",
          c,
          "commit purged from this repository's history: clone again and carry your own work over by hand",
        );
  }
  if (findings.length) finish("check-confidential", findings, started);
  // git-lfs stays off unless the push may carry LFS objects or touch a lockable file: it would
  // verify locks against the remote on every push.
  const common = resolve(root, git(["rev-parse", "--git-common-dir"], root).toString().trim());
  const storage = spawnSync("git", ["config", "--type=path", "lfs.storage"], {
    cwd: root,
  }).stdout.toString();
  // An empty objects folder holds nothing to upload.
  const holdsFile = (dir: string): boolean =>
    existsSync(dir) &&
    readdirSync(dir, { withFileTypes: true }).some(
      (e) => e.isFile() || e.isSymbolicLink() || (e.isDirectory() && holdsFile(join(dir, e.name))),
    );
  const stores = [
    join(common, "lfs/objects"),
    ...(storage.trim() ? [resolve(common, storage.trim(), "objects")] : []),
  ];
  const lfsPath = (local: string) => {
    // latin1 keeps a path's bytes as they are, whatever its encoding.
    const changed = git(["log", "--format=", "--name-only", "-z", local, ...notOnRemote], root)
      .toString("latin1")
      .split("\0")
      .filter(Boolean);
    if (!changed.length) return false;
    const paths = Buffer.from(`${[...new Set(changed)].join("\0")}\0`, "latin1");
    const attrs = (source: string[]) =>
      spawnSync("git", ["check-attr", ...source, "-z", "--stdin", "filter", "lockable"], {
        cwd: root,
        input: paths,
      });
    // --source needs Git 2.40; an older git reads the checked-out attributes.
    let r = attrs([`--source=${local}`]);
    if (r.status !== 0) r = attrs([]);
    if (r.status !== 0) throw new Error(`git check-attr: ${r.stderr}`);
    // git-lfs also refuses a change to a file someone else locked, LFS-tracked or not.
    const out = r.stdout.toString("latin1").split("\0");
    return out.some(
      (v, i) => i % 3 === 2 && ["filter=lfs", "lockable=set"].includes(`${out[i - 1]}=${v}`),
    );
  };
  if (stores.some(holdsFile) || locals.some(lfsPath)) {
    if (spawnSync("git", ["lfs", "version"], { cwd: root }).status !== 0)
      report(
        "push",
        "",
        "this push may carry Git LFS content or touch a lockable file, and git-lfs is not on PATH",
      );
    else {
      const lfs = spawnSync("git", ["lfs", "pre-push", ...argv.slice(1)], {
        cwd: root,
        input,
        stdio: ["pipe", "inherit", "inherit"],
      });
      process.exit(lfs.status ?? 1);
    }
  }
  finish("check-confidential", findings, started);
}

type TermList = { built?: string; salt: string; maxTokens: number; hashes: string[] };
const parse = (text: string): TermList | undefined => {
  try {
    const l = JSON.parse(text);
    const valid =
      Array.isArray(l?.hashes) &&
      typeof l.salt === "string" &&
      Number.isInteger(l.maxTokens) &&
      l.maxTokens >= 1 &&
      l.maxTokens <= 6;
    return valid ? l : undefined;
  } catch {
    return undefined;
  }
};
const age = (file: string) => (existsSync(file) ? Date.now() - statSync(file).mtimeMs : Infinity);
const warn = (message: string) => console.error(`[check-confidential] ${message}`);

/** Fetches the list into CACHE with the person's own gh login; answers why not, or undefined. */
function fetchList(): string | undefined {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(ATTEMPT, "");
  const r = spawnSync(
    "gh",
    [
      "api",
      `repos/${TERMS_REPO}/contents/confidential-terms.json`,
      "-H",
      "Accept: application/vnd.github.raw",
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  if (r.error) return `gh: ${r.error.message}`;
  if (r.status !== 0 || !parse(r.stdout))
    return `gh: ${(r.stderr || r.stdout).trim().replace(/^gh: /, "").split("\n")[0] || `exit ${r.status}`}`;
  writeFileSync(`${CACHE}.tmp`, r.stdout);
  renameSync(`${CACHE}.tmp`, CACHE);
}

function loadList(): { list?: TermList; problem?: string } {
  const file = arg("--list") || process.env.SCAFFOLDING_CONFIDENTIAL_TERMS || undefined;
  let problem: string | undefined;
  if (!file && age(CACHE) >= DAY && (age(CACHE) === Infinity || age(ATTEMPT) >= HOUR)) {
    problem = fetchList();
    if (problem && existsSync(CACHE)) warn(`${problem}; using the copy fetched before`);
  } else if (!file && age(CACHE) >= DAY) warn("copy older than a day; next fetch within the hour");
  const source = file ?? CACHE;
  const list = existsSync(source) ? parse(readFileSync(source, "utf8")) : undefined;
  if (!list) return { problem: problem ?? `no valid list at ${source}` };
  const built = Date.parse(list.built ?? "");
  if (Number.isNaN(built) || built > Date.now() + HOUR)
    return { problem: `${source} has no valid build time` };
  const days = (Date.now() - built) / DAY;
  if (days > 7) return { problem: `list built ${Math.floor(days)} days ago, more than 7` };
  if (days > 3) warn(`list built ${Math.floor(days)} days ago; Company OS has not rebuilt it`);
  return { list };
}

if (argv[0] === "fetch") {
  const problem = fetchList();
  const loaded = problem ? { problem } : loadList();
  if (loaded.problem) warn(loaded.problem);
  process.exit(loaded.problem ? 1 : 0);
}

if (readPackage(root).scaffolding?.private === true) process.exit(0);

let list: TermList | undefined;
// Kept out of applyAllow: no allow entry may switch the list requirement off.
const listProblem: Finding[] = [];
if (process.env.CI === "true") warn("CI: term step skipped; the commit hook is the gate");
else {
  const loaded = loadList();
  list = loaded.list;
  if (loaded.problem)
    listProblem.push({
      check: "confidential",
      path: "confidential terms",
      text: "",
      message: `${loaded.problem}. Refused: run \`gh auth login\` with an account in the ${TERMS_REPO.split("/")[0]} trainers team, then commit again`,
    });
}
const bad = new Set<string>(list?.hashes ?? []);
const h = hasher(list?.salt ?? "");

function scanText(where: string, text: string) {
  if (!list) return;
  const found = new Set<string>();
  const tokens = words(text);
  const lower = tokens.map((w) => w.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    if ((tokens[i].length === 3 || capitals(tokens[i])) && bad.has(h(`cs:${tokens[i]}`)))
      found.add(tokens[i]);
    let gram = "";
    for (let n = 0; n < list.maxTokens && i + n < tokens.length; n++) {
      gram = n ? `${gram} ${lower[i + n]}` : lower[i];
      if (gram.length > 3 && bad.has(h(gram))) found.add(tokens.slice(i, i + n + 1).join(" "));
    }
  }
  // A slug or path writes a capitalised name in lower case (quux-workshop, clients/quux/): a
  // lower-case part of a joined token is checked as the name in capitals.
  for (const [joined] of text.normalize("NFKC").matchAll(SLUG))
    for (const part of joined.split(/[-_/.]/))
      if (part.length > 3 && part === part.toLowerCase() && bad.has(h(`cs:${part.toUpperCase()}`)))
        found.add(part);
  for (const name of found)
    findings.push({
      check: "confidential",
      path: where,
      text: name,
      message: "confidential term from the company records",
      term: true,
    });
}

const IMAGE = /\.(?:png|jpe?g|webp|gif|heic|tiff?)$/i;
const OS_NAV = ["Dashboard", "Deals", "Deliverables", "Assignments", "Invoices"];

function ocrBinary(): string | undefined {
  const source = join(import.meta.dir, "../lib/ocr.swift");
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 12);
  const bin = join(CACHE_DIR, `ocr-${digest}`);
  if (existsSync(bin)) return bin;
  if (process.platform !== "darwin") return undefined;
  const built = spawnSync("swiftc", ["-O", source, "-o", bin], { stdio: "ignore" });
  return built.status === 0 ? bin : undefined;
}

function scanBinaries(files: { where: string; data: Buffer }[]) {
  if (!files.length) return;
  // A review page's images may sit under docs/agent-work once read clean. CI reads none, so there
  // they stay refused rather than pass unread.
  if (process.env.CI === "true") {
    for (const { where } of files)
      if (/(?:^|\/)docs\/agent-work\//.test(where))
        report(where, "", "image or PDF in docs/agent-work not read: no OCR in CI");
    return;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const scratch = mkdtempSync(join(CACHE_DIR, "scan-"));
  const texts = new Map<string, string>();
  const images: string[] = [];
  files.forEach(({ where, data }, i) => {
    const file = join(scratch, `${i}${where.match(/\.\w+$/)?.[0] ?? ""}`);
    writeFileSync(file, data);
    if (!/\.pdf$/i.test(where)) return images.push(file);
    const pdf = spawnSync("pdftotext", [file, "-"], { maxBuffer: Infinity });
    if (pdf.status === 0) texts.set(where, pdf.stdout.toString());
  });
  const ocr = images.length ? ocrBinary() : undefined;
  if (ocr) {
    const out = spawnSync(ocr, images, { maxBuffer: Infinity });
    for (const block of out.status === 0
      ? `\n${out.stdout}`.split(`\n== ${scratch}/`).slice(1)
      : []) {
      const [name, ...lines] = block.split("\n");
      const file = files[Number(name.split(".")[0])];
      if (file) texts.set(file.where, lines.join("\n"));
    }
  }
  rmSync(scratch, { recursive: true, force: true });
  for (const { where } of files)
    if (!texts.has(where))
      report(
        where,
        "",
        /\.pdf$/i.test(where)
          ? "PDF not read: install poppler for pdftotext"
          : "image not read: not a decodable image, or no OCR here (macOS only)",
      );
  for (const [where, text] of texts) {
    const nav = OS_NAV.filter((w) => new RegExp(`^${w}$`, "m").test(text));
    if (nav.length >= 3) report(where, nav.join(", "), "Company OS screenshot");
    scanText(where, text);
  }
}

function addedLines(diff: string) {
  const added = new Map<string, string[]>();
  let path = "";
  let previous = "";
  for (const line of diff.split("\n")) {
    // A file header is "+++ " right after "--- "; inside a hunk the same text is an added line.
    if (line.startsWith("+++ ") && previous.startsWith("--- "))
      path = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("+") && path)
      added.set(path, [...(added.get(path) ?? []), line.slice(1)]);
    previous = line;
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
    else return console.error(`[check-confidential] ${where}: Git LFS pointer, not read`);
  }
  binaries.push({ where, data });
};

const message = arg("--message-file");
const commit = arg("--commit");
const tree = arg("--tree");
// Comment lines count: `git commit -m` keeps them. Only the diff below `commit -v`'s scissors goes.
if (message) scanText("commit message", readFileSync(message, "utf8").split(/^# -+ >8 -+$/m)[0]);
else if (argv.includes("--staged") || commit) {
  const range = commit
    ? ["show", "--format=", "--no-renames", commit]
    : ["diff", "--cached", "--no-renames"];
  const diff = git(
    [
      "-c",
      "core.quotePath=false",
      ...range,
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "--diff-filter=AM",
    ],
    root,
  ).toString();
  for (const [path, lines] of addedLines(diff))
    if (!isBinary(path)) scanText(path, lines.join("\n"));
  const names = git([...range, "--name-only", "--diff-filter=AM", "-z"], root)
    .toString()
    .split("\0");
  scanText("file names", names.join("\n"));
  for (const path of names.filter((p) => p && isBinary(p)))
    take(path, blob(commit ? `${commit}:${path}` : `:${path}`));
  if (commit)
    scanText("commit message", git(["log", "-1", "--format=%B", commit], root).toString());
} else if (tree) {
  const entries = git(["ls-tree", "-r", "-z", tree], root)
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((line) => line.match(/^\d+ (\w+) (\w+)\t(.*)$/s)!);
  scanText("file names", entries.map(([, , , path]) => path).join("\n"));
  const blobs = entries.filter(([, type]) => type === "blob");
  // One cat-file for every blob: a `git show` per file cost 6.6 ms each.
  const batch = git(["cat-file", "--batch"], root, blobs.map(([, , sha]) => sha).join("\n") + "\n");
  let at = 0;
  for (const [, , , path] of blobs) {
    const header = batch.indexOf(10, at);
    const [, type, length] = batch.subarray(at, header).toString().split(" ");
    if (type !== "blob") throw new Error(`git cat-file: ${path} not readable (${type})`);
    const size = Number(length);
    const data = batch.subarray(header + 1, header + 1 + size);
    at = header + 2 + size;
    if (isBinary(path)) take(path, data);
    else if (!data.includes(0)) scanText(path, data.toString("utf8"));
  }
} else {
  console.error(
    "usage: check-confidential --staged | --message-file <file> | --commit <rev> | --tree <rev> | prepush | fetch | build <terms|-> [--public <file>] | purged <sha>...",
  );
  process.exit(2);
}
scanBinaries(binaries);

// The tree audit, the gate's step, sees every file, so an allow entry matching nothing there is
// stale. A partial scan (staged, one commit, a message) or one without the list cannot tell.
finish(
  "check-confidential",
  [...listProblem, ...applyAllow(root, "confidential", findings, Boolean(tree && list))],
  started,
);
