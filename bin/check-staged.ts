#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
// Check, never write: re-staging a rewritten file would sweep another session's unstaged lines in
// that file into this commit. Tools read a partly staged file from the index, so its unstaged
// lines neither pass nor block this commit. The skill validator reads skill files from the working
// tree.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { renderGuides } from "../lib/guides.ts";
import { help } from "../lib/help.ts";
import {
  isReason,
  pathChunks,
  readPackage,
  repoRoot,
  styled,
  stylelintFlags,
  withoutEnvFile,
} from "../lib/repo.ts";
import { otherScript } from "../lib/shell-inputs.ts";
import { runStagedOxlint } from "../lib/staged-oxlint.ts";
import { stagedDiff, stagedPaths } from "../lib/staged-paths.ts";
import {
  classifyPrettierStdin,
  ConcurrencyPool,
  findDifferingScript,
  hasNoPrettierParser,
  spawnStagedEslint,
  spawnStagedProcess,
  spawnStagedWithEnv,
  type ToolRun,
} from "../lib/staged-runner.ts";
import { inNodeModules } from "../lib/tracked-inputs.ts";

help("check-staged");
withoutEnvFile("check:staged");
process.env.SCAFFOLDING_LINT_UNTYPED = "1";

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

// The skips, scripts and pins as this commit holds them.
const root = repoRoot();
const pkg = readPackage(root, ":");
const skip = pkg.scaffolding?.skip ?? {};
// A step the gate skips with a reason is skipped here too; the term scan never is, since this hook
// is its gate.
for (const [step, check] of [
  ["coupling", "check-coupling.ts"],
  ["", "check-confidential.ts"],
]) {
  if (isReason(skip[step])) continue;
  const run = spawnSync(process.execPath, [`${import.meta.dir}/${check}`, "--staged"], {
    stdio: "inherit",
  });
  if (run.status !== 0) process.exit(1);
}

// Deletions count: removing a file can break a link the validator checks. Any status but 0
// (no change) runs it, so a failing git diff fails closed.
const claudeStaged =
  spawnSync("git", ["diff", "--cached", "--quiet", "--", ".claude"]).status !== 0;
if (claudeStaged) {
  const changed = findDifferingScript(pkg.scripts, readPackage(root).scripts);
  if (changed !== undefined)
    refuseCommit(
      `package.json script differs between index and working tree: ${JSON.stringify(changed)}. Stage package.json (\`git add package.json\`) or discard its unstaged script edit so check:skills runs the script version being committed`,
    );
}
// The script's former name would otherwise turn the validation off without a word.
if (claudeStaged && pkg.scripts?.["validate:skills"] && !pkg.scripts["check:skills"])
  refuseCommit("rename the script validate:skills to check:skills: check-staged runs check:skills");
const skills = Boolean(pkg.scripts?.["check:skills"]) && claudeStaged;

const declared = { ...pkg.dependencies, ...pkg.devDependencies };
const items =
  Boolean(declared["@hackersandwizards/admin"]) &&
  // The old folder counts too: an item staged there would otherwise pass unread.
  spawnSync("git", ["diff", "--cached", "--quiet", "--", "docs/agent-work/items", "docs/tracking"])
    .status !== 0;
// Fail closed: an item file that does not parse would reach the commit unread.
if (items && !existsSync("node_modules/.bin/admin-check"))
  refuseCommit("admin-check not installed: bun install");

// spawnSync's default maxBuffer refused a commit past about 1 MB of path names.
const names = (args: string[]) => {
  const listed = spawnSync("git", [...args, "--name-only", "--no-renames", "-z"], {
    encoding: "utf8",
    maxBuffer: Infinity,
  });
  if (listed.status !== 0)
    refuseCommit(
      `git ${args.join(" ")} failed: inspect the git error above, check \`git status\` for a lock or broken index, and retry the commit`,
    );
  return listed.stdout.split("\0").filter(Boolean);
};
const { staged, oxlintPaths, regularPaths } = stagedPaths(stagedDiff(root));
if (staged.length === 0 && !skills && !items) process.exit(0);
if (
  staged.some((path) => path === "bun.lock" || path === "package.json") &&
  !isReason(skip.licenses)
) {
  const run = spawnSync(process.execPath, [`${import.meta.dir}/check-licenses.ts`], {
    stdio: "inherit",
  });
  if (run.status !== 0) process.exit(1);
}
const differs = new Set(names(["diff"]));
const partial = staged.filter((path) => differs.has(path));
const whole = staged.filter((path) => !differs.has(path));

// Prettier and eslint get every staged path, stylelint the CSS and Astro ones the gate's styles step
// lints, and each skips what its own config ignores, so this and `bun run check` judge the same files.
const mine = (tool: string, paths: string[]) =>
  tool === "stylelint" ? paths.filter(styled) : paths;
// One list per tool for a staged file read whole and one read from stdin, so both judge alike.
const flags: Record<string, string[]> = {
  prettier: ["--ignore-unknown", "--log-level", "warn"],
  eslint: [
    "--cache",
    "--no-warn-ignored",
    "-f",
    join(import.meta.dir, "../lib/eslint-formatter.ts"),
  ],
  stylelint: stylelintFlags("."),
};
const tools: Record<string, string[]> = {
  prettier: ["--check", ...flags.prettier, "--no-error-on-unmatched-pattern"],
  eslint: [...flags.eslint, "--no-error-on-unmatched-pattern"],
  stylelint: flags.stylelint,
};
const stdinFlags: Record<string, (path: string) => string[]> = {
  // No --check: prettier --check on stdin exits 0 on a syntax error. The output is compared instead.
  prettier: (path) => [...flags.prettier, "--stdin-filepath", path],
  eslint: (path) => [...flags.eslint, "--stdin", "--stdin-filename", path],
  stylelint: (path) => [...flags.stylelint, "--stdin", "--stdin-filename", path],
};

const chunks = pathChunks(whole);
// Bounded to the core count: unbounded, 400 partly staged files started 400 processes on 16 cores.
const pool = new ConcurrencyPool(availableParallelism());

function stagedContent(path: string): Buffer {
  // spawnSync's default maxBuffer cuts a file over about 1 MB off without failing.
  const shown = spawnSync("git", ["show", `:${path}`], { maxBuffer: Infinity });
  if (shown.status !== 0)
    refuseCommit(
      `git show :${path} failed: check \`git status\` for an unmerged conflict or missing index entry on ${path}, resolve and re-stage it, then retry the commit`,
    );
  return shown.stdout;
}

function runStagedLint(tool: string, args: string[], stdin?: Buffer): Promise<ToolRun> {
  const bin = `node_modules/.bin/${tool}`;
  return pool.run(() =>
    tool === "eslint" ? spawnStagedEslint(bin, args, stdin) : spawnStagedProcess(bin, args, stdin),
  );
}

// Run what the gate runs: each tool unless scaffolding.skip gives its gate step a reason, declared
// or not. Every install is checked before any run starts, so a refusal leaves no tool running.
const gateStep: Record<string, string> = {
  prettier: "format",
  eslint: "lint",
  stylelint: "styles",
};
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
if (oxlintPaths.length && !isReason(skip.lint) && runStagedOxlint(root, oxlintPaths))
  refuseCommit(
    "oxlint refused the staged files: fix the oxlint findings reported above, stage the edits, and commit again; do not silence them with oxlint-disable",
  );

async function checkPartialFile(tool: string, path: string): Promise<ToolRun> {
  const input = stagedContent(path);
  const result = await runStagedLint(tool, stdinFlags[tool](path), input);
  if (tool === "prettier") {
    const verdict = classifyPrettierStdin(input, result);
    const passed =
      verdict === "pass" ||
      (verdict === "check-parser" &&
        hasNoPrettierParser(
          await pool.run(() =>
            spawnStagedProcess(`node_modules/.bin/${tool}`, ["--file-info", path]),
          ),
        ));
    if (passed) return { ...result, out: "", code: 0 };
    const why = !result.code ? "not formatted\n" : result.out;
    return {
      ...result,
      out: `[check:staged] ${tool}: ${path} as staged\n${why}`,
      code: result.code || 1,
    };
  }
  if (!result.code && !result.rules?.length) return { ...result, out: "", code: 0 };
  return { ...result, out: `[check:staged] ${tool}: ${path} as staged\n${result.out}` };
}

const runs = active.flatMap(([tool, args]) => [
  ...chunks
    .map((paths) => mine(tool, paths))
    .filter((paths) => paths.length)
    // A staged name starting with `-` would read as an option.
    .map((paths) => runStagedLint(tool, [...args, "--", ...paths])),
  ...mine(tool, partial).map((path) => checkPartialFile(tool, path)),
]);
const stagedInputs = regularPaths.filter((path) => !inNodeModules(path));
for (const [step, matches] of [
  ["shell", (path: string) => !otherScript.test(path)],
  ["markdown", (path: string) => path.endsWith(".md")],
] as const)
  if (!isReason(skip[step]) && stagedInputs.some(matches))
    runs.push(
      pool.run(() =>
        spawnStagedProcess(process.execPath, [`${import.meta.dir}/check-${step}.ts`, "--staged"]),
      ),
    );

// An inherited scope could narrow validation to none. Deletions can break links too.
if (skills)
  runs.push(
    pool.run(() =>
      spawnStagedWithEnv(process.execPath, ["run", "check:skills"], {
        VALIDATE_SKILLS_PATHS: names(["diff", "--cached"]).join("\n"),
      }),
    ),
  );
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
      { encoding: "utf8" },
    );
    const copied = spawnSync("git", ["checkout-index", "-z", "--stdin", `--prefix=${dir}/`], {
      input: tracked.stdout,
    });
    if (tracked.status || copied.status)
      return { out: "[check:staged] could not copy the index\n", code: 1, stdout: Buffer.alloc(0) };
    return await pool.run(() =>
      spawnStagedProcess(`${process.cwd()}/node_modules/.bin/admin-check`, [dir]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Concurrent for speed, reported in a fixed order so the output reads the same on every run.
let failed = false;
const rules = new Set<string>();
for (const { out, code, rules: fired } of await Promise.all(runs)) {
  process.stderr.write(out);
  failed ||= code !== 0;
  for (const rule of fired ?? []) rules.add(rule);
}
process.stderr.write(renderGuides(rules));
process.exit(failed ? 1 : 0);
