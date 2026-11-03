// The pre-commit check every repository runs as `bun run check:staged`: the staged secret scan, then
// `prettier --check` and `eslint` on the staged files. Check, never write: re-staging a rewritten
// file would sweep another session's unstaged lines in that file into this commit. A file whose
// working tree differs from the index is checked from the index on stdin, so those unstaged lines
// neither pass nor block this commit. A repository defining a `validate:skills` script also runs it
// whenever the index touches `.claude/`; that validator reads the working tree.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

function refuseCommit(message: string): never {
  console.error(`[check:staged] ${message}`);
  process.exit(1);
}

// Fail closed: a missing scanner would let every secret through without a word.
const scan = spawnSync(
  "gitleaks",
  ["git", "--pre-commit", "--staged", "--redact", "--no-banner", "--log-level", "warn"],
  { stdio: "inherit" },
);
if (scan.error) refuseCommit("gitleaks not found: brew install gitleaks");
if (scan.status !== 0) process.exit(1);

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
// Deletions count: removing a file can break a link the validator checks. Any status but 0
// (no change) runs it, so a failing git diff fails closed.
const skills =
  Boolean(pkg.scripts?.["validate:skills"]) &&
  spawnSync("git", ["diff", "--cached", "--quiet", "--", ".claude"]).status !== 0;

const listed = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
  encoding: "utf8",
});
if (listed.status !== 0) refuseCommit("git diff --cached failed");
const staged = listed.stdout.split("\0").filter(Boolean);
if (staged.length === 0 && !skills) process.exit(0);
const unstaged = spawnSync("git", ["diff", "--name-only", "-z"], { encoding: "utf8" });
if (unstaged.status !== 0) refuseCommit("git diff failed");
const differs = new Set(unstaged.stdout.split("\0"));
const partial = staged.filter((path) => differs.has(path));
const whole = staged.filter((path) => !differs.has(path));

// Both tools get every staged path and skip what their own config ignores, so this and
// `bun run check` judge the same files.
const tools: Record<string, string[]> = {
  prettier: [
    "--check",
    "--ignore-unknown",
    "--no-error-on-unmatched-pattern",
    "--log-level",
    "warn",
  ],
  eslint: ["--cache", "--no-warn-ignored", "--no-error-on-unmatched-pattern"],
};
const stdinFlags: Record<string, (path: string) => string[]> = {
  // No --check: prettier --check on stdin exits 0 on a syntax error. The output is compared instead.
  prettier: (path) => ["--ignore-unknown", "--log-level", "warn", "--stdin-filepath", path],
  eslint: (path) => ["--cache", "--no-warn-ignored", "--stdin", "--stdin-filename", path],
};
const declared = { ...pkg.dependencies, ...pkg.devDependencies };

// Chunked: a commit touching most of a repository passes more path bytes than ARG_MAX holds.
const chunks: string[][] = [[]];
let bytes = 0;
for (const path of whole) {
  if (bytes + path.length > 100_000) {
    chunks.push([]);
    bytes = 0;
  }
  chunks[chunks.length - 1].push(path);
  bytes += path.length + 1;
}

// Bounded to the core count: unbounded, 400 partly staged files started 400 processes on 16 cores.
let free = availableParallelism();
const waiting: (() => void)[] = [];
type ToolRun = { out: string; code: number; stdout: Buffer };

async function runStagedTool(bin: string, args: string[], stdin?: Buffer): Promise<ToolRun> {
  if (free === 0) await new Promise<void>((go) => waiting.push(go));
  else free--;
  const result = await new Promise<ToolRun>((done) => {
    const child = spawn(bin, args, { stdio: "pipe" });
    child.stdin.end(stdin);
    let out = "";
    const stdout: Buffer[] = [];
    child.stdout.on("data", (data) => stdout.push(data));
    child.stderr.on("data", (data) => (out += data));
    child.on("error", (error) =>
      done({ out: `${String(error)}\n`, code: 1, stdout: Buffer.alloc(0) }),
    );
    child.on("close", (code) => {
      const output = Buffer.concat(stdout);
      done({ out: `${output}${out}`, code: code ?? 1, stdout: output });
    });
  });
  const next = waiting.shift();
  if (next) next();
  else free++;
  return result;
}

function stagedContent(path: string): Buffer {
  // spawnSync's default maxBuffer cuts a file over about 1 MB off without failing.
  const shown = spawnSync("git", ["show", `:${path}`], { maxBuffer: Infinity });
  if (shown.status !== 0) refuseCommit(`git show :${path} failed`);
  return shown.stdout;
}

// Output equal to the input is formatted, a blank file included. Otherwise prettier prints nothing
// for a file it has no parser for, which passes, and also formats a whitespace-only file it can
// parse to nothing, which fails, so a whitespace-only one asks which it is.
async function prettierPasses(bin: string, path: string, input: Buffer, r: ToolRun) {
  if (r.code) return false;
  if (r.stdout.equals(input)) return true;
  if (r.stdout.length) return false;
  if (/\S/.test(`${input}`)) return true;
  const info = await runStagedTool(bin, ["--file-info", path]);
  return !info.code && JSON.parse(`${info.stdout}`).inferredParser === null;
}

const runs = Object.entries(tools)
  .filter(([tool]) => tool in declared)
  .flatMap(([tool, flags]) => {
    const bin = `node_modules/.bin/${tool}`;
    // Fail closed: a checkout without `bun install`, such as a fresh worktree, would pass every file.
    if (!existsSync(bin)) refuseCommit(`${tool} not installed: bun install`);
    return [
      ...chunks
        .filter((paths) => paths.length)
        .map((paths) => runStagedTool(bin, [...flags, ...paths])),
      ...partial.map(async (path) => {
        const input = stagedContent(path);
        const r = await runStagedTool(bin, stdinFlags[tool](path), input);
        if (tool === "prettier" ? await prettierPasses(bin, path, input, r) : !r.code)
          return { out: "", code: 0 };
        const why = tool === "prettier" && !r.code ? "not formatted\n" : r.out;
        return {
          out: `[check:staged] ${tool}: ${path} as staged\n${why}`,
          code: r.code || 1,
        };
      }),
    ];
  });
if (skills) runs.push(runStagedTool(process.execPath, ["run", "validate:skills"]));

// Concurrent for speed, reported in a fixed order so the output reads the same on every run.
let failed = false;
for (const { out, code } of await Promise.all(runs)) {
  process.stderr.write(out);
  failed ||= code !== 0;
}
process.exit(failed ? 1 : 0);
