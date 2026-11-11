import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Answers `--help` as the first argument with the command's row of docs/commands.md on stdout,
 * after `usage` where the command's own usage line names more than the row does. */
export function help(name: string, usage?: string) {
  if (process.argv[2] !== "--help") return;
  const doc = readFileSync(join(import.meta.dir, "..", "docs", "commands.md"), "utf8");
  const row = doc.split("\n").find((line) => new RegExp(`^\\| \`${name}[ \`]`).test(line))!;
  const [synopsis, runs, checks] = row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  console.log(`${usage ?? `usage: ${synopsis.slice(1, -1)}`}\n${checks}\nRuns in: ${runs}`);
  process.exit(0);
}
