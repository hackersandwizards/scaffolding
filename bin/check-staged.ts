#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
// Check, never write: re-staging a rewritten file would sweep another session's unstaged lines in
// that file into this commit. Tools read a partly staged file from the index, so its unstaged
// lines neither pass nor block this commit.
import { ownEntry } from "../lib/json.ts";
import { pathChunks, stagedPaths } from "../lib/staged-paths.ts";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { help } from "../lib/help.ts";
import { oxlintConfig, oxlintExtends, runOxlint } from "../lib/oxlint.ts";
import {
  isReason,
  isObject,
  jsonObject,
  readPackage,
  repoRoot,
  styled,
  stylelintFlags,
  withoutEnvFile,
} from "../lib/repo.ts";

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
const pkg = readPackage(repoRoot(), ":");
const skip = pkg.scaffolding?.skip ?? {};
// A step the gate skips with a reason is skipped here too; the term scan never is, since this hook
// is its gate.
for (const [step, check] of [
  ["coupling", "check-coupling.ts"],
  ["", "check-confidential.ts"],
]) {
  if (isReason(ownEntry(skip, step))) continue;
  const run = spawnSync(process.execPath, [`${import.meta.dir}/${check}`, "--staged"], {
    stdio: "inherit",
  });
  if (run.status !== 0) process.exit(1);
}

// Deletions count: removing a file can break a link the validator checks. Any status but 0
// (no change) runs it, so a failing git diff fails closed.
const claudeStaged =
  spawnSync("git", ["diff", "--cached", "--quiet", "--", ".claude"]).status !== 0;
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
  if (listed.status !== 0) refuseCommit(`git ${args.join(" ")} failed`);
  return listed.stdout.split("\0").filter(Boolean);
};
// ":<old mode> <new mode> <old sha> <new sha> <status>", then the path, two for a rename or copy.
const listed = spawnSync("git", ["diff", "--cached", "--raw", "--diff-filter=ACMRT", "-z"], {
  encoding: "utf8",
  maxBuffer: Infinity,
});
if (listed.status !== 0) refuseCommit("git diff --cached failed");
const { staged, oxlintPaths } = stagedPaths(listed.stdout);
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
const flags = {
  prettier: ["--ignore-unknown", "--log-level", "warn"],
  eslint: ["--cache", "--no-warn-ignored"],
  stylelint: stylelintFlags("."),
};
const tools = {
  prettier: ["--check", ...flags.prettier, "--no-error-on-unmatched-pattern"],
  eslint: [...flags.eslint, "--no-error-on-unmatched-pattern"],
  stylelint: flags.stylelint,
};
const stdinFlags = {
  // No --check: prettier --check on stdin exits 0 on a syntax error. The output is compared instead.
  prettier: (path: string) => [...flags.prettier, "--stdin-filepath", path],
  eslint: (path: string) => [...flags.eslint, "--stdin", "--stdin-filename", path],
  stylelint: (path: string) => [...flags.stylelint, "--stdin", "--stdin-filename", path],
};

const chunks = pathChunks(whole);

// Bounded to the core count: unbounded, 400 partly staged files started 400 processes on 16 cores.
let free = availableParallelism();
const waiting: (() => void)[] = [];
type ToolRun = { out: string; code: number; stdout: Buffer };

async function runStagedTool(
  bin: string,
  args: string[],
  stdin?: Buffer,
  env: Record<string, string> = {},
): Promise<ToolRun> {
  if (free === 0) await new Promise<void>((go) => waiting.push(go));
  else free--;
  const result = await new Promise<ToolRun>((done) => {
    const child = spawn(bin, args, { stdio: "pipe", env: { ...process.env, ...env } });
    // A child that exits before reading stdin raises EPIPE: caught so it cannot crash the check, and
    // counted as a failure so an unread file never passes.
    let unread = false;
    child.stdin.on("error", () => (unread = true));
    child.stdin.end(stdin);
    let out = "";
    const stdout: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => stdout.push(data));
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
  return !info.code && jsonObject(info.stdout).inferredParser === null;
}

// Run what the gate runs: each tool unless scaffolding.skip gives its gate step a reason, declared
// or not. Every install is checked before any run starts, so a refusal leaves no tool running.
const gateStep = {
  prettier: "format",
  eslint: "lint",
  stylelint: "styles",
};
const active = (["prettier", "eslint", "stylelint"] as const).filter(
  (tool) => mine(tool, staged).length && !isReason(ownEntry(skip, gateStep[tool])),
);
for (const tool of active)
  // Fail closed: a checkout without `bun install`, such as a fresh worktree, or a package that
  // does not pin the tool, would pass every file.
  if (!existsSync(`node_modules/.bin/${tool}`))
    refuseCommit(
      `${tool} not installed: pin it and bun install, or skip.${gateStep[tool]} with a reason`,
    );
if (oxlintPaths.length && !isReason(skip.lint)) {
  const root = repoRoot();
  const inputs = [oxlintConfig, ...oxlintPaths];
  const base = oxlintExtends(root);
  if (!base.startsWith("./node_modules/")) inputs.push(base.slice(2));
  const cache = join(root, "node_modules/.cache/scaffolding");
  mkdirSync(cache, { recursive: true });
  const snapshot = mkdtempSync(join(cache, "staged-oxlint-"));
  let code = 1;
  try {
    const checkout = spawnSync(
      "git",
      ["checkout-index", "-z", "--stdin", `--prefix=${snapshot}/`],
      {
        cwd: root,
        input: inputs.join("\0") + "\0",
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    if (checkout.status !== 0) throw new Error("could not check out the staged oxlint inputs");
    const configPath = join(snapshot, oxlintConfig);
    if (!lstatSync(configPath).isFile()) throw new Error(`${oxlintConfig} must be a regular file`);
    const config = jsonObject(readFileSync(configPath));
    if (!isObject(config.options) || config.options.typeAware !== true)
      throw new Error(`${oxlintConfig}: options.typeAware must be true`);
    config.options = { ...config.options, typeAware: false, typeCheck: false };
    writeFileSync(configPath, JSON.stringify(config));
    symlinkSync(join(root, "node_modules"), join(snapshot, "node_modules"), "dir");
    code = 0;
    for (const paths of pathChunks(oxlintPaths)) {
      const run = runOxlint(snapshot, [
        "--no-ignore",
        "--no-error-on-unmatched-pattern",
        "--",
        ...paths,
      ]);
      if (run.status !== 0) {
        code = run.status ?? 1;
        break;
      }
    }
  } catch (error) {
    console.error(`[check:staged] oxlint: ${(error as Error).message}`);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
  if (code) refuseCommit("oxlint refused the staged files");
}

const runs = active.flatMap((tool) => {
  const args = tools[tool];
  const bin = `node_modules/.bin/${tool}`;
  return [
    ...chunks
      .map((paths) => mine(tool, paths))
      .filter((paths) => paths.length)
      // A staged name starting with `-` would read as an option.
      .map((paths) => runStagedTool(bin, [...args, "--", ...paths])),
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
// Scoped to this commit, deletions included, over whatever the shell exported: unscoped, another
// session's half-written skill refused this commit, and an inherited scope could narrow it to none.
if (skills)
  runs.push(
    runStagedTool(process.execPath, ["run", "check:skills"], undefined, {
      VALIDATE_SKILLS_PATHS: names(["diff", "--cached"]).join("\n"),
    }),
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
