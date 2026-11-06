#!/usr/bin/env bun
// What a package ships is public wherever a consumer serves or bundles it: a comment in a shipped
// file states how to use the code and why, never the history behind it. Review scores, dates,
// decision and item ids, pointers to review notes and names go to the commit message.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyAllow,
  commentSyntax,
  finish,
  readPackage,
  repoRoot,
  type Finding,
} from "../lib/repo.ts";

const started = performance.now();
const root = repoRoot();
const itemsDir = join(root, "docs/agent-work/items");
// The repository's own item ids, such as a slug without a prefix the generic pattern misses.
const items = existsSync(itemsDir)
  ? readdirSync(itemsDir).flatMap((f) => f.match(/^([a-z0-9]+(?:-[a-z0-9]+)+)\.md$/)?.[1] ?? [])
  : [];
const HISTORY: [string, RegExp][] = [
  ["decision id", /\b(?:os\s+decision|decisions?\s+[a-z0-9]+(?:-[a-z0-9]+)+)/gi],
  [
    "review score",
    /\bblind[\s-]+(?:panels?|reviews?|rounds?|runs?|A\/B)|\bscored\b|\bnoise\s+\d|\boverall of 10\b|\bpersonas?\b|\breviewers?\b/gi,
  ],
  // A score runs to 10 and has two parts, so a version such as 2.11.1 or v1.2, or 18.2, is none.
  [
    "review score",
    /(?<![\w.])(?:10|\d)\.\d\d?\s+(?:(?:against|vs\.?|versus)\s+(?:10|\d)\.\d\d?(?!\w|\.\d)|of\s+10\b|in\s+the\s+same\s+panel\b)/gi,
  ],
  // A review note, not the item folder the admin layout names.
  ["review pointer", /\bdocs\/agent-work\/(?!items\b)\S/g],
  [
    "item id",
    new RegExp(
      String.raw`\b[A-Z]{2,4}-\d+\b|\b[Ii]tems?\s+[a-z0-9]+(?:-[a-z0-9]+)+` +
        (items.length ? String.raw`|(?<![\w-])(?:${items.join("|")})(?![\w-])` : ""),
      "g",
    ),
  ],
  // A German date's month has two digits, so a decimal closing a sentence ("only 4.7.") is none.
  [
    "date",
    /\b20\d\d-\d\d-\d\d\b|\b(?:0?[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])\.(?:20\d\d)?(?!\w)/g,
  ],
  ["person", /\b(?:Benedikt|Stefan|Stemmildt|Munz)\b/g],
];
const kinds = (text: string) => HISTORY.filter(([, re]) => text.match(re)).map(([kind]) => kind);

/** A file's comments without their marks, one string for lines only a line break separates, so an
 * id or a score wrapped across two lines reads whole. */
function readComments(path: string, text: string): string[] {
  const read: string[] = [];
  let end = 0;
  for (const m of text.matchAll(commentSyntax(path))) {
    const mark = m.index + m[0].search(/\/[/*]|<!--|#/);
    const body = text
      .slice(mark, m.index + m[0].length)
      .replace(/^\s*(?:\/\/+|\/\*+|<!--|\*+\/?|-->|#+)|(?:\*+\/|-->)\s*$/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    if (read.length && /^[ \t]*\r?\n?[ \t]*$/.test(text.slice(end, mark)))
      read[read.length - 1] += ` ${body}`;
    else read.push(body);
    end = m.index + m[0].length;
  }
  return read;
}

// Verbatim from comments that shipped in company packages, the last ones planted: a pattern that
// stops hitting its line fails the step rather than letting every file pass. A line with a path
// must first come out of that file as a comment.
const controls = [
  ["sidebar does (blind review 2026-11-06, 2 personas x Claude and Codex: overall 8.4", "date"],
  ["+0.8 at noise 0.2 over no groups). */", "review score"],
  ["// The markers' key: blind runs read the band colours", "review score"],
  ["takes sm, one only read stays pill (os\n decision label-system C, 2026-11-01).", "decision id"],
  ["readout deck's rem (decision design-system-hub-spoke: every value", "decision id"],
  ["(blind round 4, os/docs/agent-work/2026-10-29-document-accents.md", "review pointer"],
  ["The small sizes come from OS-1's three blind rounds", "item id"],
  ["the last line (blind panel 01.11.). */", "date"],
  ["(Benedikt, 01.11.: the total sat indented", "person"],
  ["the notes where enough lines fit. Blind A/B, 28.10.2026: five of six", "date"],
  ...(items.length ? [[`see ${items[0]} for the rest`, "item id"]] : []),
  ["a{b:c;}/* (Benedikt, 01.11.) */", "date", "a.css"],
  ["Item new-claim", "item id"],
  ["// the before side stays (decision\n" + "// merge-comparison, 7.94", "decision id", "a.ts"],
  [
    "(decision merge-comparison, 7.94 against 7.29 for the transform's own drawing).",
    "review score",
  ],
  ["// pushed every column's text down (7.00 in the same panel).", "review score"],
  ["Claude and Codex: 7.75 of 10 against 5.75 for both gaps).", "review score"],
];
const found: Finding[] = [];
for (const [line, kind, file] of controls)
  if (!kinds(file ? readComments(file, line).join() : line).includes(kind))
    found.push({ check: "history", path: import.meta.path, text: line, message: `misses ${kind}` });

// A repository declaring no files, exports or bin ships nothing another repository reads.
const pkg = readPackage(root);
if (!pkg.files && !pkg.exports && !pkg.bin)
  finish("history", applyAllow(root, "history", found, true), started);
const pack = spawnSync(process.execPath, ["pm", "pack", "--dry-run", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
});
const shipped = (pack.stdout ?? "")
  .split("\n")
  .flatMap((l) => l.match(/^packed \S+ (.+)$/)?.[1] ?? []);
// package.json always ships, so an empty list means pack failed or changed its output.
if (pack.status !== 0 || !shipped.length) {
  console.error(`[history] bun pm pack listed no files: ${pack.stderr ?? pack.error}`);
  process.exit(1);
}
for (const path of shipped) {
  const bytes = readFileSync(join(root, path));
  if (bytes.includes(0)) continue;
  for (const comment of readComments(path, bytes.toString("utf8")))
    for (const [kind, re] of HISTORY)
      for (const m of comment.matchAll(re)) {
        const text = comment.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
        found.push({ check: "history", path, text: text.trim(), message: kind });
      }
}
finish("history", applyAllow(root, "history", found, true), started);
