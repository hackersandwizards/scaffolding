#!/usr/bin/env bun
/**
 * Pairs of agent memories that say one thing twice (duplicate) or one thing with two values
 * (conflict), across every owner's directory, since a memory finding closes fleet-wide. Memory files
 * are compared with memory files and MEMORY.md index lines with index lines.
 *
 * Usage: bun .claude/skills/polish/memory-twins.ts [memory root]
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export type PairClass = "duplicate" | "conflict" | "different";

/** Notes shorter than this are alike only when equal: five words sharing four are usually two points. */
const MIN_WORDS = 6;
const JACCARD = 0.8;
/** A short pair conflicts only with this many identical words around its one changed value. */
const MIN_REST_WORDS = 3;
/** A value group standing first or second is the note's name ("Ticket 4711 ..."), not its value. */
const NAME_ANCHOR_MAX = 1;

const MONTHS_WEEKDAYS = [
  ...["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september"],
  ...["oktober", "november", "dezember", "jan", "feb", "mär", "mrz", "apr", "jun", "jul", "aug"],
  ...["sep", "sept", "okt", "nov", "dez", "january", "february", "march", "may", "june", "july"],
  ...["october", "december", "mar", "oct", "dec", "montag", "dienstag", "mittwoch", "donnerstag"],
  ...["freitag", "samstag", "sonnabend", "sonntag", "monday", "tuesday", "wednesday", "thursday"],
  ...["friday", "saturday", "sunday"],
];
const NEGATIONS = new Set(
  ["nicht", "kein", "keine", "keinen", "keiner", "nie", "niemals", "not", "no", "never"].concat([
    "none",
    "without",
    "ohne",
  ]),
);
const VALUE_WORDS = new Set([...MONTHS_WEEKDAYS, ...NEGATIONS]);
const HAS_DIGIT = /\p{N}/u;

interface Group {
  /** How many plain words precede the group: the place two notes are aligned by. */
  anchor: number;
  tokens: string[];
}

interface Note {
  words: string[];
  set: Set<string>;
  values: string[];
  rest: string[];
  groups: Group[];
}

/** "may" is the month only beside a digit or at the end of a note; otherwise it is the verb. */
const isValue = (words: string[], at: number) => {
  const w = words[at];
  if (!VALUE_WORDS.has(w) && !HAS_DIGIT.test(w)) return false;
  if (w !== "may" || at === words.length - 1) return true;
  return HAS_DIGIT.test(words[at + 1]) || (at > 0 && HAS_DIGIT.test(words[at - 1]));
};

/** Adjacent values form one group, so a date written as three words is one changed value. */
export function readMemoryNote(text: string): Note {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const note: Note = { words, set: new Set(words), values: [], rest: [], groups: [] };
  let open: Group | null = null;
  words.forEach((w, at) => {
    if (!isValue(words, at)) {
      note.rest.push(w);
      open = null;
      return;
    }
    note.values.push(w);
    if (open && !NEGATIONS.has(w)) return void open.tokens.push(w);
    open = { anchor: note.rest.length, tokens: [w] };
    note.groups.push(open);
    if (NEGATIONS.has(w)) open = null;
  });
  return note;
}

/** "01" and "1" are one value. */
const comparable = (w: string) => (/^\d+$/.test(w) ? w.replace(/^0+(?=\d)/, "") : w);
const keyAt = (n: Note, anchor: number) =>
  n.groups
    .filter((g) => g.anchor === anchor)
    .map((g) => g.tokens.map(comparable).join(" "))
    .join(" | ");
const sameSeq = (a: string[], b: string[]) =>
  a.length === b.length && a.every((w, i) => w === b[i]);

function noteDifferingAnchors(a: Note, b: Note): number[] {
  const anchors = [...new Set([...a.groups, ...b.groups].map((g) => g.anchor))];
  return anchors.filter((x) => keyAt(a, x) !== keyAt(b, x)).sort((x, y) => x - y);
}

function notesLookAlike(a: Note, b: Note): boolean {
  if (a.words.length < MIN_WORDS || b.words.length < MIN_WORDS) return false;
  const ja = ` ${a.words.join(" ")} `;
  const jb = ` ${b.words.join(" ")} `;
  if (ja.includes(jb) || jb.includes(ja)) return true;
  let shared = 0;
  for (const w of a.set) if (b.set.has(w)) shared++;
  return shared / (a.set.size + b.set.size - shared) >= JACCARD;
}

export function classifyMemoryPair(a: Note, b: Note): PairClass {
  if (!a.words.length || !b.words.length) return "different";
  if (sameSeq(a.words, b.words)) return "duplicate";
  const differing =
    a.rest.length >= MIN_REST_WORDS && sameSeq(a.rest, b.rest) ? noteDifferingAnchors(a, b) : null;
  if (differing?.length === 0) return "duplicate";
  if (
    differing?.length === 1 &&
    differing[0] <= NAME_ANCHOR_MAX &&
    [a, b].every((n) =>
      n.groups.every(
        (g) => g.anchor !== differing[0] || g.tokens.every((t) => !VALUE_WORDS.has(t)),
      ),
    )
  )
    return "different";
  if (notesLookAlike(a, b)) {
    const sa = a.values.map(comparable).sort();
    const sb = b.values.map(comparable).sort();
    return sameSeq(sa, sb) ? "duplicate" : "conflict";
  }
  return differing?.length === 1 ? "conflict" : "different";
}

interface Unit {
  where: string;
  note: Note;
}

/** A file's description plus body, an index line's text: frontmatter keys and link targets dropped. */
async function memoryUnits(root: string): Promise<{ files: Unit[]; lines: Unit[] }> {
  const files: Unit[] = [];
  const lines: Unit[] = [];
  // A repository without agent memory has nothing to compare.
  if (!existsSync(root)) return { files, lines };
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  for (const e of entries.filter((x) => x.isFile() && x.name.endsWith(".md"))) {
    const path = join(e.parentPath, e.name);
    const where = relative(process.cwd(), path);
    const raw = await readFile(path, "utf-8");
    const strip = (s: string) => s.replace(/\]\([^)]*\)/g, "]").replace(/\[\[[^\]]*\]\]/g, "");
    if (e.name === "MEMORY.md") {
      raw.split("\n").forEach((l, i) => {
        if (l.startsWith("- "))
          lines.push({ where: `${where}:${i + 1}`, note: readMemoryNote(strip(l)) });
      });
      continue;
    }
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
    const description = fm?.[1].match(/^description:\s*(.*)$/m)?.[1] ?? "";
    files.push({
      where,
      note: readMemoryNote(strip(`${description}\n${raw.slice(fm?.[0].length ?? 0)}`)),
    });
  }
  return { files, lines };
}

export function memoryPairs(list: Unit[]): { kind: PairClass; a: string; b: string }[] {
  const out: { kind: PairClass; a: string; b: string }[] = [];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const kind = classifyMemoryPair(list[i].note, list[j].note);
      if (kind !== "different") out.push({ kind, a: list[i].where, b: list[j].where });
    }
  return out;
}

if (import.meta.main) {
  const { files, lines } = await memoryUnits(process.argv[2] ?? ".claude/agent-memory");
  const found = [...memoryPairs(files), ...memoryPairs(lines)];
  for (const p of found) console.log(`${p.kind}\t${p.a}\t${p.b}`);
  const count = (k: PairClass) => found.filter((p) => p.kind === k).length;
  console.log(
    `${files.length} memory files, ${lines.length} index lines: ` +
      `${count("duplicate")} duplicate and ${count("conflict")} conflict pair(s).`,
  );
}
