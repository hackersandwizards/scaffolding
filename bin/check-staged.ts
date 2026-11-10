#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
// Check, never write: re-staging a rewritten file would sweep another session's unstaged lines in
// that file into this commit. A file whose working tree differs from the index is checked from the
// index on stdin, so those unstaged lines neither pass nor block this commit.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import {
  isReason,
  readPackage,
  repoRoot,
  styled,
  stylelintFlags,
  withoutEnvFile,
} from "../lib/repo.ts";

withoutEnvFile("check:staged");

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

for (const check of ["check-coupling.ts", "check-confidential.ts"]) {
  const run = spawnSync(process.execPath, [`${import.meta.dir}/${check}`, "--staged"], {
    stdio: "inherit",
  });
  if (run.status !== 0) process.exit(1);
}

// The skips, scripts and pins as this commit holds them.
const pkg = readPackage(repoRoot(), ":");
// Deletions count: removing a file can break a link the validator checks. Any status but 0
// (no change) runs it, so a failing git diff fails closed.
const skills =
  Boolean(pkg.scripts?.["validate:skills"]) &&
  spawnSync("git", ["diff", "--cached", "--quiet", "--", ".claude"]).status !== 0;

const declared = { ...pkg.dependencies, ...pkg.devDependencies };
const items =
  Boolean(declared["@hackersandwizards/admin"]) &&
  // The old folder counts too: an item staged there would otherwise pass unread.
  spawnSync("git", ["diff", "--cached", "--quiet", "--", "docs/agent-work/items", "docs/tracking"])
    .status !== 0;
// Fail closed: an item file that does not parse would reach the commit unread.
if (items && !existsSync("node_modules/.bin/admin-check"))
  refuseCommit("admin-check not installed: bun install");

// ":<old mode> <new mode> <old sha> <new sha> <status>", then the path, two for a rename or copy.
const listed = spawnSync("git", ["diff", "--cached", "--raw", "--diff-filter=ACMR", "-z"], {
  encoding: "utf8",
  maxBuffer: Infinity,
});
if (listed.status !== 0) refuseCommit("git diff --cached failed");
const staged: string[] = [];
const fields = listed.stdout.split("\0");
for (let i = 0; i + 1 < fields.length;) {
  const [, mode, , , status] = fields[i].split(" ");
  const paths = /^[RC]/.test(status) ? 2 : 1;
  // A submodule's commit (mode 160000) is no file for the tools.
  if (mode !== "160000") staged.push(fields[i + paths]);
  i += paths + 1;
}
if (staged.length === 0 && !skills && !items) process.exit(0);
if (staged.some((path) => path === "bun.lock" || path === "package.json")) {
  const run = spawnSync(process.execPath, [`${import.meta.dir}/check-licenses.ts`], {
    stdio: "inherit",
  });
  if (run.status !== 0) process.exit(1);
}
const unstaged = spawnSync("git", ["diff", "--name-only", "-z"], {
  encoding: "utf8",
  maxBuffer: Infinity,
});
if (unstaged.status !== 0) refuseCommit("git diff failed");
const differs = new Set(unstaged.stdout.split("\0"));
const partial = staged.filter((path) => differs.has(path));
const whole = staged.filter((path) => !differs.has(path));

// Prettier and eslint get every staged path, stylelint the CSS and Astro ones the gate's styles step
// lints, and each skips what its own config ignores, so this and `bun run check` judge the same files.
const mine = (tool: string, paths: string[]) =>
  tool === "stylelint" ? paths.filter(styled) : paths;
const tools: Record<string, string[]> = {
  prettier: [
    "--check",
    "--ignore-unknown",
    "--no-error-on-unmatched-pattern",
    "--log-level",
    "warn",
  ],
  eslint: ["--cache", "--no-warn-ignored", "--no-error-on-unmatched-pattern"],
  stylelint: stylelintFlags("."),
};
const stdinFlags: Record<string, (path: string) => string[]> = {
  // No --check: prettier --check on stdin exits 0 on a syntax error. The output is compared instead.
  prettier: (path) => ["--ignore-unknown", "--log-level", "warn", "--stdin-filepath", path],
  eslint: (path) => ["--cache", "--no-warn-ignored", "--stdin", "--stdin-filename", path],
  stylelint: (path) => [...tools.stylelint, "--stdin", "--stdin-filename", path],
};

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
    // A child that exits before reading stdin raises EPIPE: caught so it cannot crash the check, and
    // counted as a failure so an unread file never passes.
    let unread = false;
    child.stdin.on("error", () => (unread = true));
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
      done({ out: `${output}${out}`, code: unread ? code || 1 : (code ?? 1), stdout: output });
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

// Run what the gate runs: each tool unless scaffolding.skip gives its gate step a reason, declared
// or not. Every install is checked before any run starts, so a refusal leaves no tool running.
const gateStep: Record<string, string> = {
  prettier: "format",
  eslint: "lint",
  stylelint: "styles",
};
const skip = pkg.scaffolding?.skip ?? {};
const active = Object.entries(tools).filter(
  ([tool]) => mine(tool, staged).length && !isReason(skip[gateStep[tool]]),
);
for (const [tool] of active)
  // Fail closed: a checkout without `bun install`, such as a fresh worktree, or a package that
  // does not pin the tool, would pass every file.
  if (!existsSync(`node_modules/.bin/${tool}`))
    refuseCommit(
      `${tool} not installed: pin it and bun install, or skip.${gateStep[tool]} with a reason`,
    );
const runs = active.flatMap(([tool, flags]) => {
  const bin = `node_modules/.bin/${tool}`;
  return [
    ...chunks
      .map((paths) => mine(tool, paths))
      .filter((paths) => paths.length)
      .map((paths) => runStagedTool(bin, [...flags, ...paths])),
    ...mine(tool, partial).map(async (path) => {
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
if (items) runs.push(checkStagedItems());

// admin-check over the index, not the working tree: docs/agent-work as staged, written to a temporary
// folder, so another session's unstaged item edit neither blocks nor passes this commit.
async function checkStagedItems(): Promise<ToolRun> {
  // Inside the checkout, never the system's temp folder: item files can hold company data.
  const cache = join(process.cwd(), "node_modules/.cache/scaffolding");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "staged-items-"));
  try {
    const tracked = spawnSync(
      "git",
      ["ls-files", "-z", "--", "docs/agent-work", "docs/tracking", "GOAL.md"],
      {
        encoding: "utf8",
      },
    );
    const copied = spawnSync("git", ["checkout-index", "-z", "--stdin", `--prefix=${dir}/`], {
      input: tracked.stdout,
    });
    if (tracked.status || copied.status)
      return { out: "[check:staged] could not copy the index\n", code: 1, stdout: Buffer.alloc(0) };
    return await runStagedTool(`${process.cwd()}/node_modules/.bin/admin-check`, [dir]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Concurrent for speed, reported in a fixed order so the output reads the same on every run.
let failed = false;
for (const { out, code } of await Promise.all(runs)) {
  process.stderr.write(out);
  failed ||= code !== 0;
}
process.exit(failed ? 1 : 0);
