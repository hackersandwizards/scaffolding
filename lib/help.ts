import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Answers `--help` as the first argument with the command's row of docs/commands.md on stdout,
 * after `usage` where the command's own usage line names more than the row does. */
export function help(name: string, usage?: string) {
  if (process.argv[2] !== "--help") return;
  const doc = readFileSync(join(import.meta.dir, "..", "docs", "commands.md"), "utf8");
  const row = doc.split("\n").find((line) => new RegExp(`^\\| \`${name}[ \`]`).test(line));
  if (!row)
    throw new Error(
      `Help for ${name} is unavailable because its row is missing from scaffolding's docs/commands.md. Report the missing row to the package maintainer or restore it in the scaffolding source checkout.`,
    );
  const [synopsis, runs, checks] = row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  console.log(`${usage ?? `usage: ${synopsis.slice(1, -1)}`}\n${checks}\nRuns in: ${runs}`);
  process.exit(0);
}
