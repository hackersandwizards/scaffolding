#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
//   check-confidential --staged               pre-commit: added lines and binary files in the index
//   --list-optional                           with --staged or --message-file: no list reachable
//                                             passes with a warning, for outside contributors, as
//                                             does a file this machine cannot read (no OCR)
//   check-confidential --message-file <file>  commit-msg: the commit message
//   check-confidential --commit <rev>         one commit: its added lines, images, PDFs and message
//   check-confidential --index                every file of the index, the gate's audit
//   check-confidential --tree <rev>           every file of a tree, for an audit
//   check-confidential prepush                pre-push: refuses commits listed in
//                                             .confidential-purged.json, then hands the refs to
//                                             `git lfs pre-push` where the push may carry LFS content
//                                             or touch a lockable file
//   check-confidential never                  reads {"<where>": <text or JSON>} on stdin, refuses every
//                                             name of the list's never section in any case, in
//                                             private repositories too: a deck test's strings
//   check-confidential fetch                  fetches the list now, for a cloud setup script
//   check-confidential build <terms|-> [--public <file>] [--never <file>]
//                                             prints a hashed list from one term per line (- reads
//                                             stdin), stamped with its build time, leaving out every
//                                             term the public text in <file> already carries;
//                                             --never adds the never section, every name kept;
//                                             --never - reads it from stdin after a NUL byte
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
import { extname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  applyAllow,
  finish,
  git,
  reader,
  readPackage,
  repoRoot,
  type Finding,
} from "../lib/repo.ts";

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
  // One stdin carries both lists: the terms, a NUL byte, then the never names. Under `bun run` the
  // command cannot open a fourth pipe (/dev/fd/3: EACCES, Bun 1.4.4).
  const stdin = [argv[1], arg("--never")].includes("-") ? readFileSync(0, "utf8") : "";
  const cut = stdin.includes("\0") ? stdin.indexOf("\0") : stdin.length;
  const piped = [stdin.slice(0, cut), stdin.slice(cut + 1)];
  const lines = (file: string, part: number) =>
    (file === "-" ? piped[part] : readFileSync(file, "utf8"))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  const terms = lines(argv[1], 0);
  const LEGAL = /\s+(?:gmbh|ag|se|kg|ug|mbh|co|ltd|inc|llc|plc|bv|sa|sarl|gmbh & co\.? kg)\.?$/i;
  // The scan reads grams of six words at most, so a longer term counts by its first six.
  const first = (term: string) => words(term).slice(0, 6);
  const norm = (term: string) => first(term).join(" ").toLowerCase();
  const variantsOf = (term: string) =>
    LEGAL.test(term) ? [term, term.replace(LEGAL, "")] : [term];
  // The names h&w never shows. An empty section would pass every deck, and a name under three
  // letters, its legal form dropped, would match ordinary words.
  const neverFile = argv.includes("--never") ? (arg("--never") ?? "") : undefined;
  const names = neverFile ? lines(neverFile, 1) : [];
  const short = names.filter((t) =>
    variantsOf(t).some((v) => norm(v).replaceAll(" ", "").length < 3),
  );
  if (neverFile !== undefined && (!names.length || short.length)) {
    console.error(
      `[check-confidential] --never: ${short.length ? `under three letters: ${short.join(", ")}` : "no name"}; not building`,
    );
    process.exit(1);
  }
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
  let maxTokens = 1;
  /** The hash the public scans look up, none for a dictionary word, and the variant's casing. */
  const hashOf = (variant: string) => {
    const tokens = first(variant);
    const n = norm(variant);
    maxTokens = Math.max(maxTokens, tokens.length);
    const one = tokens.length === 1;
    const cased = one && (n.length === 3 || capitals(tokens[0]));
    const word = one && n.length > 3 && dict.has(n) && !capitals(tokens[0]);
    return { n, hash: word ? undefined : h(cased ? `cs:${tokens[0]}` : n), anyCase: cased || word };
  };
  const hashes = new Set<string>();
  for (const term of terms) {
    const variants = variantsOf(term);
    if (variants.some((v) => published.has(norm(v)))) continue;
    for (const variant of variants) {
      const { n, hash } = hashOf(variant);
      if (n.length >= 3 && hash) hashes.add(hash);
    }
  }
  // No public text drops a never name. A cased one or a dictionary word also gets a hash under
  // "any:", which only the never scan reads: a public scan keeps the rules above, and a deck still
  // refuses the name in any case.
  const never = new Set<string>();
  for (const name of names)
    for (const variant of variantsOf(name)) {
      const { n, hash, anyCase } = hashOf(variant);
      if (hash) never.add(hash);
      if (anyCase) never.add(h(`any:${n}`));
    }
  const built = new Date().toISOString();
  console.log(
    JSON.stringify({
      built,
      salt,
      maxTokens,
      hashes: [...hashes].sort(),
      never: neverFile ? [...never].sort() : undefined,
    }),
  );
  process.exit(0);
}

if (argv[0] === "purged") {
  // Adds to the repository's list under its own salt. `> .confidential-purged.json` empties the
  // file before this runs, so then the index's copy counts.
  const top = repoRoot();
  let old: { salt: string; hashes: string[] } | undefined;
  for (const read of [reader(top, false), reader(top, true)])
    try {
      old = JSON.parse(read(".confidential-purged.json").toString());
      break;
    } catch {}
  const salt = old?.salt ?? randomBytes(16).toString("hex");
  const hashes = new Set([...(old?.hashes ?? []), ...argv.slice(1).map(hasher(salt))]);
  console.log(JSON.stringify({ salt, hashes: [...hashes].sort() }));
  process.exit(0);
}

const neverMode = argv[0] === "never";
// A deploy needs no access, nor a Git checkout.
if (neverMode && process.env.CI === "true") {
  console.error("[check-confidential] CI: never scan skipped");
  process.exit(0);
}
const root = repoRoot();
const CACHE_DIR = join(root, "node_modules/.cache/scaffolding");
const CACHE = join(CACHE_DIR, "confidential-terms.json");
const ATTEMPT = `${CACHE}.attempt`;
const findings: Finding[] = [];
const report = (path: string, text: string, message: string) => {
  findings.push({ check: "confidential", path, text, message });
};

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
    // Only the tips the remote reports count as held there: a stale tracking ref or a fetched pull
    // request may still point into the purged history.
    const commits = locals.flatMap((local) =>
      git(["rev-list", local, "--ignore-missing", "--not", ...sha(3)], root)
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
  // An empty objects folder holds nothing to upload.
  const holdsFile = (dir: string): boolean =>
    existsSync(dir) &&
    readdirSync(dir, { withFileTypes: true }).some(
      (e) => e.isFile() || e.isSymbolicLink() || (e.isDirectory() && holdsFile(join(dir, e.name))),
    );
  const stores = lfsObjectDirs();
  const lfsPath = (local: string) => {
    // latin1 keeps a path's bytes as they are, whatever its encoding. -c lists the paths a merge's
    // resolution changes; what it takes from a side counts through that side's own commits.
    const changed = git(
      ["log", "-c", "--format=", "--name-only", "-z", local, ...notOnRemote],
      root,
    )
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

type TermList = {
  built?: string;
  salt: string;
  maxTokens: number;
  hashes: string[];
  never?: string[];
};
const parse = (text: string): TermList | undefined => {
  try {
    const l = JSON.parse(text);
    const valid =
      Array.isArray(l?.hashes) &&
      (l.never === undefined || Array.isArray(l.never)) &&
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

/** `optional`: a hook that passes without a list tries gh at most hourly even without a copy, since
 * gh may take 20 s offline; a hook that refuses without one tries on every commit. */
function loadList(optional = false): { list?: TermList; problem?: string; absent?: boolean } {
  const file = arg("--list") || process.env.SCAFFOLDING_CONFIDENTIAL_TERMS || undefined;
  let problem: string | undefined;
  const due = age(ATTEMPT) >= HOUR || (age(CACHE) === Infinity && !optional);
  // A copy fetched before Company OS built the never section is fetched again for the never scan.
  const old =
    age(CACHE) >= DAY ||
    (neverMode && existsSync(CACHE) && !parse(readFileSync(CACHE, "utf8"))?.never?.length);
  if (!file && old && due) {
    problem = fetchList();
    if (problem && existsSync(CACHE)) warn(`${problem}; using the copy fetched before`);
  } else if (!file && old)
    warn(
      existsSync(CACHE)
        ? `copy ${age(CACHE) >= DAY ? "older than a day" : "without a never section"}; next fetch within the hour`
        : "no copy; next fetch within the hour, or now by `check-confidential fetch`",
    );
  const source = file ?? CACHE;
  const list = existsSync(source) ? parse(readFileSync(source, "utf8")) : undefined;
  if (!list)
    return { problem: problem ?? `no valid list at ${source}`, absent: !existsSync(source) };
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

const CHECK = neverMode ? "never-shown" : "confidential";
const message = arg("--message-file");
const commit = arg("--commit");
// Only the hooks of an outside contributor's commit go without a list; an audit never does.
const optional =
  argv.includes("--list-optional") && (argv.includes("--staged") || Boolean(message));
const tree = arg("--tree");
const index = argv.includes("--index");
// A deploy's audit needs no access; a commit, its message or a push is scanned wherever it is made.
const skipped = process.env.CI === "true" && Boolean(tree || index);
// `private` and the allow list come from the snapshot scanned, so a commit adding a case and its
// allow entry together is judged as one and an unstaged edit switches no scan off. A message
// belongs to the commit the index makes. The never scan reads what the working tree renders, and
// runs in a private repository too: no surface shows those names.
const pkg = readPackage(root, neverMode ? undefined : (tree ?? commit ?? ":"));
if (pkg.scaffolding?.private === true && !neverMode) process.exit(0);
// package.json's allow entries name the very terms and paths they allow, so the file is read without
// them, each entry's reason kept: whole, as the snapshot holds it, since its added lines alone cannot
// tell an entry from the rest.
const ownPackage = JSON.stringify(
  {
    ...pkg,
    scaffolding: pkg.scaffolding && {
      ...pkg.scaffolding,
      allow: pkg.scaffolding.allow?.map(({ text: _t, path: _p, ...rest }) => rest),
    },
  },
  null,
  2,
);
const ownText = (path: string, text: string) => (path === "package.json" ? ownPackage : text);

let list: TermList | undefined;
// No list reachable under --list-optional: the commit passes unscanned for terms.
let unscanned = false;
// Kept out of applyAllow: no allow entry may switch the list requirement off.
const listProblem: Finding[] = [];
if (skipped) warn("CI: term step skipped; the commit hook is the gate");
else {
  const loaded = loadList(optional);
  list = loaded.list;
  // For a public repository's outside contributors, who cannot fetch the list: no list at all
  // passes, a stale or broken one still refuses.
  unscanned = Boolean(loaded.absent && optional);
  if (unscanned) warn(`${loaded.problem}; --list-optional: terms not scanned`);
  else if (loaded.problem)
    listProblem.push({
      check: CHECK,
      path: "confidential terms",
      text: "",
      message: `${loaded.problem}. Refused: run \`gh auth login\` with an account in the ${TERMS_REPO.split("/")[0]} trainers team, then ${neverMode ? "run it" : "commit"} again`,
    });
  // A list without names to look for would pass every deck.
  else if (neverMode && !list?.never?.length)
    listProblem.push({
      check: CHECK,
      path: "confidential terms",
      text: "",
      message:
        "the list has no never section: Company OS has not built one, or `check-confidential fetch` fetches it now",
    });
}
// A public repository's own scans refuse a never name too, under their casing rule.
const bad = new Set<string>([...(neverMode ? [] : (list?.hashes ?? [])), ...(list?.never ?? [])]);
const h = hasher(list?.salt ?? "");

/** `inPath`: `text` is the path `where` itself. */
function scanText(where: string, text: string, inPath = false) {
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
      // One word of three letters is a cased term. Two one-character words ("K 2") count only
      // in capitals, since in lower case they are code (`c => a`).
      const pair = n === 1 && gram.length === 3;
      const counts = pair ? capitals(tokens[i] + tokens[i + 1]) : n || gram.length > 3;
      if ((counts && bad.has(h(gram))) || (neverMode && !n && bad.has(h(`any:${gram}`))))
        found.add(tokens.slice(i, i + n + 1).join(" "));
    }
  }
  // A slug or path writes a capitalised name in lower case (quux-workshop, clients/quux/): a
  // lower-case part of a joined token is checked as the name in capitals.
  for (const [joined] of text.normalize("NFKC").matchAll(SLUG))
    for (const part of joined.split(/[-_/.]/))
      if (part.length >= 3 && part === part.toLowerCase() && bad.has(h(`cs:${part.toUpperCase()}`)))
        found.add(part);
  for (const name of found)
    findings.push({
      check: CHECK,
      path: where,
      text: name,
      message: `${neverMode ? "a name h&w never shows" : "confidential term"} from the company records${inPath ? " in the file's path" : ""}`,
      term: true,
      ...(inPath && { name: true as const }),
    });
}

const IMAGE = /\.(?:png|jpe?g|webp|gif|heic|heif|avif|tiff?|bmp|ico|icns)$/i;
// Glyph outlines, no text a scan could read, known by their own signature: WOFF, WOFF2, OpenType,
// TrueType and a collection at the start, EOT's at byte 34. An Office file's embedded font is
// obfuscated, so there the name alone tells.
const FONT = ["wOFF", "wOF2", "OTTO", "\0\x01\0\0", "true", "ttcf"];
const font = (name: string, data: Buffer, depth: number) =>
  FONT.includes(data.subarray(0, 4).toString("latin1")) ||
  data.subarray(34, 36).toString("latin1") === "LP" ||
  (depth > 0 && /\.odttf$/i.test(name));
const XML = /\.(?:xml|rels|x?html?|svg)$/i;
// Paragraphs, breaks, cells and list items of Office, OpenDocument and HTML markup.
const BLOCK = /<\/?(?:\w+:)?(?:p|h\d?|br|tab|tc|td|th|tr|si|c|li|div|line-break)\b[^>]*>/g;
const OS_NAV = ["Dashboard", "Deals", "Deliverables", "Assignments", "Invoices"];

const OCR_SOURCE = join(import.meta.dir, "../lib/ocr.swift");

function ocrBinary(): string | undefined {
  const digest = createHash("sha256").update(readFileSync(OCR_SOURCE)).digest("hex").slice(0, 12);
  const bin = join(CACHE_DIR, `ocr-${digest}`);
  if (existsSync(bin)) return bin;
  if (process.platform !== "darwin") return undefined;
  const built = spawnSync("swiftc", ["-O", OCR_SOURCE, "-o", bin], { stdio: "ignore" });
  return built.status === 0 ? bin : undefined;
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const fromCode = (code: number, m: string) => (code <= 0x10ffff ? String.fromCodePoint(code) : m);
const decode = (s: string) =>
  s.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (m, d, x, name) =>
    d || x ? fromCode(parseInt(d ?? x, d ? 10 : 16), m) : (ENTITY[name] ?? m),
  );

/** The entries of a zip archive (Office, OpenDocument, iWork, .zip), or why it cannot be read. */
function unzip(data: Buffer): { name: string; data: Buffer }[] | string {
  try {
    return entriesOf(data);
  } catch (e) {
    return `damaged zip archive (${(e as Error).message})`;
  }
}

function entriesOf(data: Buffer): { name: string; data: Buffer }[] | string {
  const end = data.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
  if (end < 0) return "no zip directory";
  const entries: { name: string; data: Buffer }[] = [];
  let at = data.readUInt32LE(end + 16);
  for (let n = data.readUInt16LE(end + 10); n > 0; n--) {
    if (data.readUInt32LE(at) !== 0x02014b50) return "damaged zip directory";
    const [flags, method] = [data.readUInt16LE(at + 8), data.readUInt16LE(at + 10)];
    const size = data.readUInt32LE(at + 20);
    const nameLength = data.readUInt16LE(at + 28);
    const name = data.toString("utf8", at + 46, at + 46 + nameLength);
    const local = data.readUInt32LE(at + 42);
    at += 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
    if (name.endsWith("/")) continue;
    if (flags & 1) return `${name} is encrypted`;
    if (size === 0xffffffff || local === 0xffffffff) return "zip64 archive";
    const from = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const raw = data.subarray(from, from + size);
    if (method === 0) entries.push({ name, data: raw });
    else if (method === 8) entries.push({ name, data: inflateRawSync(raw) });
    else return `${name} uses compression method ${method}`;
  }
  return entries;
}

function scanBinaries(files: { where: string; data: Buffer }[]) {
  if (!files.length) return;
  // A review page's images may sit under docs/agent-work once read clean. A CI audit reads none, so
  // there they stay refused rather than pass unread.
  if (skipped) {
    for (const { where } of files)
      if (/(?:^|\/)docs\/agent-work\//.test(where))
        report(where, "", "binary file in docs/agent-work not read: no OCR in CI");
    return;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const scratch = mkdtempSync(join(CACHE_DIR, "scan-"));
  const texts = new Map<string, string>();
  const add = (where: string, text: string) =>
    texts.set(where, `${texts.get(where) ?? ""}\n${text}`);
  const images: { file: string; where: string; entry: string; why: string }[] = [];
  // Only a file read whole is kept as read: one not read is tried again.
  const unread = new Set<string>();
  const refuse = (where: string, entry: string, message: string) => {
    unread.add(where);
    report(where, entry, message);
  };
  // A file this machine lacks the tool to read. Where the commit goes unscanned for terms anyway, it
  // passes with a warning; only the Company OS screenshot check is lost with it.
  const notRead = (where: string, entry: string, message: string) => {
    if (!unscanned) return refuse(where, entry, message);
    unread.add(where);
    warn(`${where}${entry && ` (${entry})`}: ${message}; --list-optional: passed unread`);
  };
  let saved = 0;
  const save = (data: Buffer, name: string) => {
    const file = join(scratch, `${saved++}${extname(name)}`);
    writeFileSync(file, data);
    return file;
  };
  // `name` is the file's own name, inside an archive the entry's; findings name `where`.
  const read = (where: string, name: string, data: Buffer, depth = 0): void => {
    const entry = name === where ? "" : name;
    if (/\.pdf$/i.test(name) || data.subarray(0, 5).toString() === "%PDF-") {
      const file = save(data, "x.pdf");
      const pdf = spawnSync("pdftotext", [file, "-"], { maxBuffer: Infinity });
      if (pdf.status !== 0)
        return notRead(where, entry, `PDF not read: install poppler for pdftotext`);
      const pages = pdf.stdout.toString().split("\f").slice(0, -1);
      add(where, pages.join("\n"));
      // "page num type width ..." under two header lines, one row per image.
      const listed = spawnSync("pdfimages", ["-list", file]);
      if (listed.status !== 0)
        return notRead(where, entry, `PDF not read: install poppler for pdfimages`);
      const pictured = new Set(
        listed.stdout
          .toString()
          .split("\n")
          .slice(2)
          .map((row) => Number(row.trim().split(/\s+/)[0])),
      );
      // A page without a word is a scan, and an image may show text: OCR reads the page's rendering.
      pages.forEach((page, i) => {
        if (/[\p{L}\p{N}]/u.test(page) && !pictured.has(i + 1)) return;
        const out = `${file}-${i + 1}`;
        const r = spawnSync("pdftoppm", [
          "-r",
          "150",
          "-png",
          "-singlefile",
          "-f",
          `${i + 1}`,
          "-l",
          `${i + 1}`,
          file,
          out,
        ]);
        if (r.status !== 0)
          notRead(
            where,
            entry,
            `PDF page ${i + 1} holds a scan or an image and was not rendered: install poppler for pdftoppm`,
          );
        else
          images.push({
            file: `${out}.png`,
            where,
            entry,
            why: `PDF page ${i + 1} holds a scan or an image and was not read: no OCR here (macOS only)`,
          });
      });
    } else if (IMAGE.test(name))
      images.push({
        file: save(data, name),
        where,
        entry,
        why: `image not read: not a decodable image, or no OCR here (macOS only)`,
      });
    else if (data.subarray(0, 4).toString("latin1") === "PK\x03\x04" && depth < 3) {
      const entries = unzip(data);
      if (typeof entries === "string") return refuse(where, entry, `archive not read: ${entries}`);
      add(where, entries.map((e) => e.name).join("\n"));
      for (const e of entries) read(where, e.name, e.data, depth + 1);
    } else if (!data.includes(0)) {
      const text = data.toString("utf8");
      // Markup read twice: a block's tag as a line break and every other tag dropped joins a word
      // Word splits across runs; every tag as a space keeps apart what no block tag separates.
      add(
        where,
        XML.test(name) || text.startsWith("<?xml")
          ? decode(
              `${text.replace(/<[^>]*>/g, " ")}\n${text.replace(BLOCK, "\n").replace(/<[^>]*>/g, "")}`,
            )
          : text,
      );
    } else if (!font(name, data, depth))
      refuse(where, entry, `binary file not read: name it with a reason in scaffolding.allow`);
  };
  // Each file's text is kept by its content and this reader's code, so a gate reads a file again
  // only once either changes.
  const reader = createHash("sha256")
    .update(readFileSync(import.meta.path))
    .update(readFileSync(OCR_SOURCE));
  const kept = files.map(({ data }) =>
    join(CACHE_DIR, "read", reader.copy().update(data).digest("hex").slice(0, 32)),
  );
  files.forEach(({ where, data }, i) =>
    existsSync(kept[i]) ? add(where, readFileSync(kept[i], "utf8")) : read(where, where, data),
  );
  const ocr = images.length ? ocrBinary() : undefined;
  const blocks = new Map<string, string>();
  if (ocr) {
    const out = spawnSync(
      ocr,
      images.map((i) => i.file),
      { maxBuffer: Infinity },
    );
    if (out.status === 0)
      // A recognised line may itself start "== ": only a scratch path opens a block.
      for (const block of `\n${out.stdout}`.split(`\n== ${scratch}/`).slice(1)) {
        const [file, ...lines] = block.split("\n");
        blocks.set(join(scratch, file), lines.join("\n"));
      }
  }
  rmSync(scratch, { recursive: true, force: true });
  for (const { file, where, entry, why } of images)
    if (blocks.has(file)) add(where, blocks.get(file)!);
    else notRead(where, entry, why);
  mkdirSync(join(CACHE_DIR, "read"), { recursive: true });
  files.forEach(({ where }, i) => {
    if (unread.has(where) || existsSync(kept[i])) return;
    // Renamed into place, so a killed run leaves no part of a text that later reads as whole.
    writeFileSync(`${kept[i]}.${process.pid}`, texts.get(where) ?? "");
    renameSync(`${kept[i]}.${process.pid}`, kept[i]);
  });
  for (const [where, text] of texts) {
    const nav = OS_NAV.filter((w) => new RegExp(`^${w}$`, "m").test(text));
    if (nav.length >= 3) report(where, nav.join(", "), "Company OS screenshot");
    scanText(where, text);
  }
}

/** Added lines per path; `paths` are the diff's files in its order, one per `diff --git` line. */
function addedLines(diff: string, paths: string[]) {
  const added = new Map<string, string[]>();
  let path: string | undefined;
  let file = -1;
  let hunk = false;
  for (const line of diff.split("\n")) {
    // A hunk's lines start with " ", "+", "-" or "\\", so only a file's header starts "diff --git".
    if (line.startsWith("diff --git ")) [path, hunk] = [paths[++file], false];
    else if (line.startsWith("@@")) hunk = true;
    else if (hunk && path !== undefined && line.startsWith("+")) {
      if (!added.has(path)) added.set(path, []);
      added.get(path)!.push(line.slice(1));
    }
  }
  return added;
}

let full = false;
const isBinary = (p: string) => IMAGE.test(p) || /\.pdf$/i.test(p);
/** The blobs `names` (a SHA, `:<path>`, `<rev>:<path>`) name, by one cat-file: a `git show` per
 * file cost 6.6 ms each. An error names the file by its path in `paths`. */
function objects(names: string[], paths: string[]): Buffer[] {
  if (!names.length) return [];
  const batch = git(["cat-file", "--batch"], root, names.join("\n") + "\n");
  let at = 0;
  return paths.map((path) => {
    const header = batch.indexOf(10, at);
    const [, type, length] = batch.subarray(at, header).toString().split(" ");
    if (type !== "blob") throw new Error(`git cat-file: ${path} not readable (${type})`);
    const data = batch.subarray(header + 1, header + 1 + Number(length));
    at = header + 2 + Number(length);
    return data;
  });
}
const binaries: { where: string; data: Buffer }[] = [];
// A pointer is all a blob holds, so a text that only starts like one is still read as text.
const POINTER =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:ext-[^\n]*\n)*oid sha256:[0-9a-f]{64}\nsize \d+\n?$/;
const isLfsPointer = (data: Buffer) => data.length < 1024 && POINTER.test(data.toString());
const OID = /^oid sha256:([0-9a-f]{64})$/m;
let lfsStores: string[] | undefined;
/** The folders of the local Git LFS store's objects: the common Git folder's, and lfs.storage's. */
function lfsObjectDirs(): string[] {
  const common = resolve(root, git(["rev-parse", "--git-common-dir"], root).toString().trim());
  const storage = spawnSync("git", ["config", "--type=path", "lfs.storage"], { cwd: root })
    .stdout.toString()
    .trim();
  return [join(common, "lfs/objects"), ...(storage ? [resolve(common, storage, "objects")] : [])];
}

/** The file a Git LFS pointer names, from the working tree where it matches the pointer's oid,
 * else from the local LFS store; undefined where neither holds it. */
function lfsContent(where: string, pointer: Buffer): Buffer | undefined {
  const text = pointer.toString();
  const oid = OID.exec(text)?.[1];
  const size = Number(/^size (\d+)$/m.exec(text)?.[1]);
  if (!oid || !Number.isFinite(size)) return undefined;
  lfsStores ??= lfsObjectDirs();
  const at = join(oid.slice(0, 2), oid.slice(2, 4), oid);
  for (const file of [join(root, where), ...lfsStores.map((dir) => join(dir, at))]) {
    // The size rules a differing file out without reading it.
    const found = statSync(file, { throwIfNoEntry: false });
    if (!found?.isFile() || found.size !== size) continue;
    const data = readFileSync(file);
    if (createHash("sha256").update(data).digest("hex") === oid) return data;
  }
}
const take = (where: string, data: Buffer) => {
  if (isLfsPointer(data)) {
    const content = lfsContent(where, data);
    if (!content) return console.error(`[check-confidential] ${where}: Git LFS pointer, not read`);
    data = content;
  }
  binaries.push({ where, data });
};

// Comment lines count: `git commit -m` keeps them. Only the diff below `commit -v`'s scissors goes.
if (message) scanText("commit message", readFileSync(message, "utf8").split(/^# -+ >8 -+$/m)[0]);
else if (argv.includes("--staged") || commit) {
  const range = commit
    ? ["show", "--format=", "--no-renames", commit]
    : ["diff", "--cached", "--no-renames"];
  // No user setting may change what the scan sees: a textconv driver's text in place of a binary,
  // or a submodule's log, which has no "diff --git" header and shifts every later file's lines.
  const options = [
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules",
    "--diff-filter=AM",
  ];
  // "<added>\t<deleted>\t<path>", "-" for a file git diffs as binary, in the patch's order.
  const files = git([...range, ...options, "--numstat", "-z"], root)
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((line) => ({ binary: line.startsWith("-\t-\t"), path: line.replace(/^\S+\t\S+\t/, "") }));
  const paths = files.map((f) => f.path);
  for (const path of paths) scanText(path, path, true);
  const texts = addedLines(git([...range, ...options, "-U0"], root).toString(), paths);
  const binary = new Set(files.filter((f) => f.binary || isBinary(f.path)).map((f) => f.path));
  // A Git LFS pointer is text to git, and its oid line changes with the file it names.
  const read = paths.filter((p) => binary.has(p) || texts.get(p)?.some((l) => OID.test(l)));
  const data = objects(
    read.map((path) => `${commit ?? ""}:${path}`),
    read,
  );
  const taken = new Set<string>();
  read.forEach((path, i) => {
    if (!binary.has(path) && !isLfsPointer(data[i])) return;
    taken.add(path);
    take(path, data[i]);
  });
  for (const path of paths)
    if (!taken.has(path)) scanText(path, ownText(path, texts.get(path)?.join("\n") ?? ""));
  if (commit)
    scanText("commit message", git(["log", "-1", "--format=%B", commit], root).toString());
} else if (neverMode) {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  // A value may nest: its object keys and every string in it are its text, so a deck goes in whole.
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : value && typeof value === "object"
        ? Object.entries(value).flatMap(([key, item]) => [
            ...(Array.isArray(value) ? [] : [key]),
            ...strings(item),
          ])
        : [];
  const texts =
    input && typeof input === "object" && !Array.isArray(input)
      ? Object.entries(input).map(([where, value]) => [where, strings(value)] as const)
      : [];
  // Kept out of applyAllow like the list's own problems: a broken dump passes nothing.
  if (!texts.length || texts.some(([, text]) => !text.length))
    listProblem.push({
      check: CHECK,
      path: "stdin",
      text: "",
      message:
        'nothing to scan: stdin holds no {"<where>": <value>} object, each value a string or JSON holding one',
    });
  else {
    full = true;
    // A key may be a slug the deck shows in its address. Each string apart, so two never join into
    // a name neither shows.
    for (const [where, text] of texts) for (const piece of [where, ...text]) scanText(where, piece);
  }
} else if (tree || index) {
  full = true;
  const listed = git(tree ? ["ls-tree", "-r", "-z", tree] : ["ls-files", "-s", "-z"], root)
    .toString()
    .split("\0")
    .filter(Boolean);
  const entries = listed.map((line) => {
    if (tree) {
      const [, type, sha, path] = line.match(/^\d+ (\w+) (\w+)\t(.*)$/s)!;
      return { type, sha, path };
    }
    // "<mode> <sha> <stage>\t<path>"; mode 160000 is a submodule's commit.
    const [, mode, sha, stage, path] = line.match(/^(\d+) (\w+) (\d)\t(.*)$/s)!;
    if (stage !== "0") {
      console.error(
        `[check-confidential] ${path}: unmerged; resolve the merge, then scan the index`,
      );
      process.exit(1);
    }
    return { type: mode === "160000" ? "commit" : "blob", sha, path };
  });
  for (const { path } of entries) scanText(path, path, true);
  const blobs = entries.filter((e) => e.type === "blob");
  const data = objects(
    blobs.map((e) => e.sha),
    blobs.map((e) => e.path),
  );
  blobs.forEach(({ path }, i) => {
    if (isBinary(path) || data[i].includes(0) || isLfsPointer(data[i])) take(path, data[i]);
    else scanText(path, ownText(path, data[i].toString("utf8")));
  });
} else {
  console.error(
    "usage: check-confidential --staged | --message-file <file> [--list-optional] | --commit <rev> | --index | --tree <rev> | never | prepush | fetch | build <terms|-> [--public <file>] [--never <file>] | purged <sha>...",
  );
  process.exit(2);
}
scanBinaries(binaries);

// A full scan (the index, the gate's step, a tree, or the never scan, handed every string the caller
// shows) sees every case, so an allow entry matching nothing there is stale. A partial scan (staged, one commit, a message) or one without the list
// cannot tell.
finish(
  "check-confidential",
  [...listProblem, ...applyAllow(pkg, CHECK, findings, full && Boolean(list))],
  started,
);
