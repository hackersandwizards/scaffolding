import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commentSyntax } from "../lib/repo.ts";

// What the package ships is public wherever a consumer serves or bundles it, such as the catalog
// shell's CSS on a Pages site: a comment in it states how to use the code and why, never the
// history behind it. Review scores, dates, decision and item ids and names go to the commit
// message.
const ROOT = join(import.meta.dir, "..");
const HISTORY: [string, RegExp][] = [
  ["decision id", /\b(?:os\s+decision|decisions?\s+[a-z0-9]+(?:-[a-z0-9]+)+)/i],
  [
    "review score",
    /\bblind[\s-]+(?:panels?|reviews?|rounds?|A\/B)|\bscored\b|\bnoise\s+\d|\boverall of 10\b|\bpersonas?\b|\breviewers?\b/i,
  ],
  ["item id", /\b[A-Z]{2,4}-\d+\b|\bitems?\s+[a-z0-9]+(?:-[a-z0-9]+)+/],
  ["date", /\b20\d\d-\d\d-\d\d\b|\b\d{1,2}\.(?:0?[1-9]|1[0-2])\.(?:20\d\d)?(?!\w)/],
  ["person", /\b(?:Benedikt|Stefan|Stemmildt|Munz)\b/],
];
const findHistory = (text: string) =>
  HISTORY.filter(([, re]) => re.test(text)).map(([kind]) => kind);
const comments = (source: string, path: string) =>
  (source.match(commentSyntax(path)) ?? []).join("\n");

test("the patterns hit the history the shipped files carried", () => {
  // Verbatim from the comments that shipped up to v2.10.0.
  for (const [line, kind] of [
    [
      "sidebar does (blind review 2026-11-06, 2 personas x Claude and Codex: overall 8.4 of 10 over",
      "review score",
    ],
    ["read as running into the right edge (blind review 2026-11-02). */", "date"],
    ["+0.8 at noise 0.2 over no groups). */", "review score"],
    [
      "window (shown 2026-10-31). A caller starting the binary itself passes chromeArgs; puppeteer takes",
      "date",
    ],
    ["The small sizes come from OS-1's three blind rounds", "item id"],
    ["which Benedikt found too slim to see", "person"],
  ])
    expect(findHistory(line)).toContain(kind);
  expect(comments("a { b: c } /* one */\n#id { x: 'https://x.y' } // two", "a.css")).toBe(
    " /* one */\n// two",
  );
  expect(comments("# hook\nrun", "template/.githooks/pre-commit")).toBe("# hook");
});

test("no shipped file's comments carry review history", () => {
  const pack = Bun.spawnSync([process.execPath, "pm", "pack", "--dry-run", "--ignore-scripts"], {
    cwd: ROOT,
  });
  expect(pack.exitCode, pack.stderr.toString()).toBe(0);
  const shipped = pack.stdout
    .toString()
    .split("\n")
    .flatMap((line) => line.match(/^packed \S+ (.+)$/)?.[1] ?? []);
  expect(shipped.length).toBeGreaterThan(50);
  const hits = shipped
    .map((file) => ({
      file,
      kinds: findHistory(comments(readFileSync(join(ROOT, file), "utf8"), file)),
    }))
    .filter((h) => h.kinds.length);
  expect(hits).toEqual([]);
});
