#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { allChangedSteps, fastSteps, selectChangedSteps, validGlob } from "../lib/changed-steps.ts";
import {
  brandProblem,
  brandSteps,
  changedBrandSteps,
  linksProblem,
  placedSteps,
  pinsPackage,
  serverProblem,
} from "../lib/gate-config.ts";
import { help } from "../lib/help.ts";
import { ownEntry } from "../lib/own-entry.ts";
import {
  isReason,
  isObject,
  readPackage,
  repoRoot,
  styleFiles,
  stylelintFlags,
  submodulePaths,
  SIGNALS,
  underLock,
  withoutEnvFile,
  type Package,
} from "../lib/repo.ts";
import { machineLoad } from "../lib/serve.ts";
import { gitShellShebangs, needsShellShebang, shellInput } from "../lib/shell-inputs.ts";
import { inNodeModules, regularInput } from "../lib/tracked-inputs.ts";

const usage =
  "usage: scaffolding check [--changed [<from>..<to>...]] | scaffolding shell | scaffolding markdown [--fix]";
help("scaffolding", usage);
withoutEnvFile("scaffolding");

// Every key of the Package type's scaffolding and no other, or typecheck fails.
const KEYS = new Set(
  Object.keys({
    allow: 0,
    private: 0,
    typecheck: 0,
    test: 0,
    brand: 0,
    server: 0,
    linkSkips: 0,
    skip: 0,
    check: 0,
    styles: 0,
    licenses: 0,
    changed: 0,
    fullOnly: 0,
  } satisfies Record<keyof NonNullable<Package["scaffolding"]>, 0>),
);

const args = process.argv.slice(2).filter((a) => a !== "--locked");
const changed = args[1] === "--changed";
const ranges = args.slice(2);
const [command, ...commandArgs] = args;
const direct =
  (command === "shell" && commandArgs.length === 0) ||
  (command === "markdown" &&
    (commandArgs.length === 0 || (commandArgs.length === 1 && commandArgs[0] === "--fix")));
if (direct) {
  const run = spawnSync(
    process.execPath,
    ["--no-env-file", join(import.meta.dir, `check-${command}.ts`), ...commandArgs],
    { stdio: "inherit" },
  );
  process.exit(run.status ?? 1);
}
if (
  command !== "check" ||
  (!changed && args.length > 1) ||
  ranges.some((r) => !/^(?:(?!\.\.)\S)+\.\.(?!\.)(?:(?!\.\.)\S)+$/.test(r))
) {
  console.error(usage);
  process.exit(2);
}
const root = repoRoot();
const home = join(import.meta.dir, "..");
await underLock(root, args);

const pkg = readPackage(root);
const config = pkg.scaffolding ?? {};
function fail(message: string): never {
  console.error(`[scaffolding] ${message}`);
  process.exit(1);
}
for (const key of Object.keys(config)) if (!KEYS.has(key)) fail(`unknown key scaffolding.${key}`);
// The checks that read scaffolding.allow: an entry naming any other is never read.
const ALLOWS = new Set(["coupling", "confidential", "never-shown", "structure", "spaces"]);
for (const entry of config.allow ?? [])
  if (!ALLOWS.has(entry.check ?? ""))
    fail(`scaffolding.allow names no check that reads it: ${entry.check}`);

const script = (s: string) => (ownEntry(pkg.scripts, s) ? `bun run --silent ${s}` : s);
// Quoted for `sh -c`: a package path holding a space failed every bin step.
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const bin = (name: string) => `bun ${quote(join(home, "bin", `${name}.ts`))}`;
// A submodule is its own repository's to check: format, lint and styles walk past it.
const submodules = submodulePaths(root).map((path) => quote(`${path}/**`));
const ignored = submodules.map((p) => ` --ignore-pattern ${p}`).join("");
const shared: Record<string, string> = {
  // Ahead of lint, which waits for it where it runs Astro (below).
  typecheck: `bun --bun ${config.typecheck ?? "tsc --noEmit"}`,
  format: `bun --bun prettier --check --cache --log-level warn .${submodules.map((p) => ` '!'${p}`).join("")}`,
  // No --cache: a typed rule's verdict on a file changes with the types it imports, which the
  // cache, keyed by the file alone, would keep. One process: each worker builds the type program
  // again, which took longer than linting in turn (30 s against 20 s over 540 files).
  lint: `bun --bun eslint .${ignored}`,
  oxlint: `bun ${quote(join(home, "lib", "oxlint.ts"))}`,
  styles: `bun --bun stylelint "${styleFiles}" ${stylelintFlags(root).join(" ")}${ignored}`,
  structure: bin("check-structure"),
  coupling: bin("check-coupling"),
  cycles: bin("check-cycles"),
  shell: bin("check-shell"),
  markdown: bin("check-markdown"),
  spaces: bin("check-spaces"),
  // The index: what the next commit holds, judged by its own allow list.
  confidential: `${bin("check-confidential")} --index`,
  licenses: bin("check-licenses"),
  // Tests are shared too: a gate without them is a skip someone wrote down, not one that drifted.
  test: script(config.test ?? ""),
  // The catalog build, so a broken one goes red here rather than on the Pages run.
  catalog: "bun run --silent build",
  admin: "admin-check",
};
if (!config.test && !isReason(config.skip?.test))
  fail("scaffolding.test is missing: name the tests, or skip.test with a reason");
const declared = { ...pkg.dependencies, ...pkg.devDependencies };
if (!("@hackersandwizards/admin" in declared) && !isReason(config.skip?.admin))
  fail("@hackersandwizards/admin is not pinned: pin it, or skip.admin with a reason");
for (const problem of [brandProblem(pkg), serverProblem(config.server), linksProblem(config)])
  if (problem) fail(problem);
const skip = { ...config.skip };
const entries = (config.check ?? []).flat();
const local = entries.filter((step) => !placedSteps.has(step));
const full = new Map<string, string>();
const replacements = new Map<string, string>();
const replaced = (step: string) => {
  const replacement = `check:${step}`;
  if (!local.includes(replacement)) return false;
  if (!isReason(ownEntry(pkg.scripts, replacement)))
    fail(`scaffolding.check requires a script named ${replacement}`);
  replacements.set(step, replacement);
  return true;
};
const withServer = (command: string) => {
  const server = config.server;
  if (!server) fail("scaffolding.server is required for a server-backed check");
  const flags = [
    server.timeout === undefined ? "" : ` --timeout ${server.timeout}`,
    server.stderr ? " --stderr" : "",
  ].join("");
  return `${bin("with-server")}${flags} ${quote(server.command)} -- ${command}`;
};
if (pinsPackage(pkg, "@hackersandwizards/brand")) {
  const brand = config.brand;
  const directory = brand?.directory ? `cd ${quote(brand.directory)} && ` : "";
  for (const step of brandSteps) {
    if (replaced(step)) continue;
    if (step === "colours") shared[step] = `${directory}brand-colours`;
    if (step === "copies") shared[step] = "brand-copies";
    if (step === "retired")
      full.set(step, `brand-retired ${(brand?.retired ?? []).map(quote).join(" ")}`);
    if (step === "elements")
      full.set(
        step,
        `${directory}${brand?.elements === "server" && !isReason(skip.elements) ? withServer("brand-elements --base {url}") : "brand-elements"}`,
      );
  }
}
if (pinsPackage(pkg, "@hackersandwizards/slides") && !replaced("pins")) shared.pins = "slides-pins";
if (config.server && !replaced("links"))
  full.set(
    "links",
    withServer(
      [
        bin("check-links"),
        "{url}",
        ...(config.linkSkips ?? []).map((prefix) => `--skip ${quote(prefix)}`),
      ].join(" "),
    ),
  );
const named = new Set([...Object.keys(shared), ...full.keys(), ...local]);
for (const [step, reason] of Object.entries(skip)) {
  if (step === "oxlint" || !(Object.hasOwn(shared, step) || full.has(step)))
    fail(`scaffolding.skip names no shared step: ${step}`);
  if (!isReason(reason)) fail(`scaffolding.skip.${step} has no reason`);
  named.add(step);
  delete shared[step];
  full.delete(step);
  if (step === "lint") delete shared.oxlint;
}

for (const step of new Set(entries))
  if (placedSteps.has(step) || [...replacements.values()].includes(step)) {
    if (entries.filter((entry) => entry === step).length > 1)
      fail(`scaffolding.check lists ${step} more than once`);
    if (placedSteps.has(step) && !named.has(step))
      fail(`scaffolding.check names no enabled shared step: ${step}`);
  }
for (const [step, replacement] of replacements)
  console.error(`[scaffolding] ${step} uses local ${replacement}`);

const fullOnly = new Map([["catalog", "builds the catalog"], ...placedSteps]);
if (config.fullOnly !== undefined && !isObject(config.fullOnly))
  fail("scaffolding.fullOnly must be a map of steps to reasons");
for (const [step, reason] of Object.entries(config.fullOnly ?? {})) {
  if (step !== "test" && !(step.startsWith("check:") && local.includes(step)))
    fail(`scaffolding.fullOnly names no eligible step: ${step}`);
  if (!isReason(reason)) fail(`scaffolding.fullOnly.${step} has no reason`);
  fullOnly.set(step, reason);
}

if (config.changed !== undefined && !isObject(config.changed))
  fail("scaffolding.changed must be a map of paths to steps");
const mappings = Object.entries(config.changed ?? {}).map(([glob, steps]) => {
  if (!validGlob(glob)) fail(`scaffolding.changed["${glob}"] is no repository-relative glob`);
  if (!Array.isArray(steps)) fail(`scaffolding.changed["${glob}"] is no list of steps`);
  if (!steps.length) fail(`scaffolding.changed["${glob}"] is an empty list of steps`);
  for (const step of steps)
    if (!named.has(step)) fail(`scaffolding.changed["${glob}"] names no step: ${step}`);
  return { glob: new Bun.Glob(glob), steps };
});

const fast = fastSteps([...Object.keys(shared), ...local], fullOnly);

function changedSteps(): Map<string, string> {
  const fallback = (why: string) => {
    console.error(`[scaffolding] --changed: ${why}: all fast steps run`);
    return allChangedSteps(fast, why);
  };
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  const diffPaths = (...revs: string[]) =>
    git("diff", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", ...revs, "--");
  const pathsFrom = (names: string) => names.split("\0").filter(Boolean);
  const paths = new Set<string>();
  const shellShebangs = new Set<string>();
  const shellCandidates = (paths: string[]) =>
    fast.has("shell")
      ? paths.filter((path) => !inNodeModules(path) && needsShellShebang(path))
      : [];
  let since = "HEAD";
  if (ranges.length) {
    for (const range of ranges) {
      const [from, to] = range.split("..") as [string, string];
      if (/^0+$/.test(from)) return fallback(`${range} starts a new branch`);
      const tip = (rev: string) =>
        git("rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`);
      const old = tip(from);
      const next = tip(to);
      if (old.status !== 0) return fallback(`${range} starts at a commit this clone lacks`);
      if (next.status !== 0) return fallback(`${range} ends at a commit this clone lacks`);
      const base = old.stdout.trim();
      const head = next.stdout.trim();
      const ancestor = git("merge-base", "--is-ancestor", base, head);
      if (ancestor.status !== 0) return fallback(`${range} is not a verifiable fast-forward`);
      const diff = diffPaths(base, head);
      if (diff.status !== 0) return fallback("git could not list the changes");
      const touched = pathsFrom(diff.stdout);
      for (const path of touched) paths.add(path);
      const candidates = shellCandidates(touched);
      try {
        for (const ref of [base, head])
          for (const path of gitShellShebangs(root, candidates, ref)) shellShebangs.add(path);
      } catch {
        return fallback("git could not read shell shebangs in the pushed ranges");
      }
    }
    since = ranges.map((r) => r.split("..")[0]!.slice(0, 9)).join(", ");
  } else {
    const upstream = git("rev-parse", "--verify", "-q", "@{upstream}").stdout.trim();
    const base = upstream ? git("merge-base", upstream, "HEAD").stdout.trim() : "HEAD";
    const diff = diffPaths(base);
    const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
    if (!base || diff.status !== 0 || untracked.status !== 0)
      return fallback("git could not list the changes");
    const touched = pathsFrom(diff.stdout);
    for (const path of [...touched, ...pathsFrom(untracked.stdout)]) paths.add(path);
    try {
      for (const path of gitShellShebangs(root, shellCandidates(touched), base))
        shellShebangs.add(path);
      for (const path of shellCandidates([...paths]))
        if (regularInput(root, path) && shellInput(path, join(root, path))) shellShebangs.add(path);
    } catch {
      return fallback("could not read shell shebangs in the base commit or working tree");
    }
    if (upstream) since = upstream.slice(0, 9);
  }
  const { steps, fallback: why } = selectChangedSteps(
    [...paths],
    fast,
    local,
    mappings,
    shellShebangs,
  );
  for (const path of paths)
    for (const step of changedBrandSteps(path, config.brand?.directory))
      if (fast.has(step) && !steps.has(step)) steps.set(step, `matches ${JSON.stringify(path)}`);
  if (why !== undefined) console.error(`[scaffolding] --changed: ${why}: all fast steps run`);
  else console.error(`[scaffolding] --changed: ${paths.size} paths since ${since}`);
  return steps;
}

const { load, cores, factor } = machineLoad();
// A test runner's per-test limit (bun's and vitest's default 5 s), stretched as serve's wait is;
// the repository's test command passes it on, since the gate cannot add a flag to any runner.
const env = {
  ...process.env,
  PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}`,
  SCAFFOLDING_TEST_TIMEOUT_MS: String(Math.round(5000 * factor)),
  SCAFFOLDING_CHANGED: changed ? "1" : "0",
  SCAFFOLDING_EXPLORING: undefined,
  SCAFFOLDING_EXPLORE_SEED: undefined,
  SCAFFOLDING_EXPLORE_RUNS: undefined,
  STRYKER_MUTATOR_WORKER: undefined,
};
type Result = { name: string; code: number; ms: number };

// Above one waiting process per core, the tests and the build run one after another once the quick
// shared checks have run side by side: started all at once on a loaded machine, they starved each
// other past every fixed limit inside them, and a correct tree went red. The repository's steps then
// run `width` at a time: the cores times the share of a core each waiting process gets, at least 2.
const loaded = load > cores;
const width = loaded ? Math.max(2, Math.floor((cores * cores) / load)) : Infinity;
if (loaded)
  console.error(
    `[scaffolding] load ${Math.round(load)} on ${cores} cores: ${changed ? "test runs after the other shared steps" : "test and catalog run one after another"}, the repository's steps ${width} at a time`,
  );

const started = performance.now();
const results: Result[] = [];
const running = new Map<string, { out: string }>();
const line = (r: Result) =>
  `[scaffolding] ${r.code ? "FAIL" : "ok  "} ${r.name} ${(r.ms / 1000).toFixed(1)} s`;

// A step is reported the moment it ends, its output ahead of its line, so a red step shows at once
// rather than after its slowest sibling, and a gate cut off still shows every step that ended.
function run(name: string, command: string, buffered: boolean): Promise<Result> {
  const begun = performance.now();
  const step = { out: "" };
  running.set(name, step);
  return new Promise((done) => {
    const child = spawn("sh", ["-c", command], {
      cwd: root,
      env,
      stdio: buffered ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    child.stdout?.on("data", (d) => (step.out += d));
    child.stderr?.on("data", (d) => (step.out += d));
    child.on("close", (code) => {
      running.delete(name);
      const r = { name, code: code ?? 1, ms: performance.now() - begun };
      process.stderr.write(step.out);
      console.error(line(r));
      results.push(r);
      done(r);
    });
  });
}

// A signal ends the steps through check-lock, which signals the whole group; this prints what the
// running ones said so far and names them, then dies by the same signal.
for (const signal of SIGNALS)
  process.on(signal, () => {
    for (const [name, step] of running) {
      process.stderr.write(step.out);
      console.error(`[scaffolding] stopped ${name} by ${signal}`);
    }
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });

// A step named in `after` starts once the step it names, listed before it, has finished, passed
// or failed. Under load the steps named in `quick` still run side by side, and the others then run
// `limit` at a time.
async function group(
  steps: [string, string][],
  after: Record<string, string> = {},
  quick = new Set<string>(),
  limit = width,
): Promise<boolean> {
  const runs = new Map<string, Promise<Result>>();
  const start = (n: string, c: string, buffered: boolean) => {
    const first = runs.get(after[n] ?? "");
    runs.set(n, first ? first.then(() => run(n, c, buffered)) : run(n, c, buffered));
  };
  const queue = loaded ? steps.filter(([n]) => !quick.has(n)) : [];
  const beside = steps.filter((step) => !queue.includes(step));
  for (const [n, c] of beside) start(n, c, steps.length > 1);
  if (queue.length) await Promise.all(runs.values());
  // One at a time, a step writes straight to the terminal.
  const worker = async () => {
    for (let step; (step = queue.shift());) {
      start(step[0], step[1], limit > 1 && steps.length > 1);
      await runs.get(step[0]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  return (await Promise.all(runs.values())).every((r) => r.code === 0);
}

// A typecheck of `astro check` and the catalog's `astro build` both run Astro's sync, whose Vite
// server optimizes dependencies into one folder (node_modules/.astro/vite-sync). On a cache an
// install invalidated, two at once race on its rename and one fails with ENOTEMPTY, so the catalog
// build waits for a typecheck that runs Astro. A plain tsc shares no folder with it. Lint waits
// for it too: the sync writes the content types (.astro/), and without them the typed rules read
// every content entry as `any` (1,724 findings against 899 in one fresh checkout).
// `bun --bun <name>` runs a package script of that name before a binary.
const typecheck = config.typecheck ?? "";
const sync = /\bastro\b/.test(
  [typecheck, ...typecheck.split(/\s+/).map((word) => pkg.scripts?.[word])].join(" "),
);
const selected = changed ? changedSteps() : undefined;
if (
  selected &&
  sync &&
  shared.typecheck &&
  !selected.has("typecheck") &&
  ((shared.lint && selected.has("lint")) || (shared.oxlint && selected.has("oxlint")))
)
  selected.set("typecheck", "Astro lint needs generated types");
const runs = (name: string) => {
  if (!selected) return true;
  const reason = fullOnly.get(name);
  const picked = selected.get(name);
  if (reason) console.error(`[scaffolding] deferred ${name}: ${reason}`);
  else if (picked) console.error(`[scaffolding] selected ${name}: ${picked}`);
  else console.error(`[scaffolding] skipped ${name}: no changed path maps to it`);
  return !reason && Boolean(picked);
};
if (selected) {
  console.error("[scaffolding] selected install: runs on every changed check");
  for (const [step, reason] of Object.entries(skip)) {
    console.error(`[scaffolding] skipped ${step}: ${String(reason)}`);
    if (step === "lint") console.error(`[scaffolding] skipped oxlint: ${String(reason)}`);
  }
}
const sharedSteps = Object.entries(shared).filter(([name]) => runs(name));
const localGroups = (config.check ?? []).map((entry) =>
  (Array.isArray(entry) ? entry : [entry])
    .filter((name) => !placedSteps.has(name) || full.has(name))
    .filter(runs)
    .map((s): [string, string] => [s, full.get(s) ?? script(s)]),
);
localGroups.push([...full].filter(([name]) => !entries.includes(name) && runs(name)));
const quick = (name: string) => name !== "test" && name !== "catalog";
const order = Object.keys(shared);

// Install first: a tree a pin-raising merge left behind gets installed, and a lockfile out of step
// fails under its own name, not a later step's.
let ok = await group([["install", "bun install --frozen-lockfile"]]);
// An unclassified test or local command may launch Chrome. Prepare it once to avoid concurrent
// downloads, but a changed run limited to shared static checks cannot reach those commands.
const mayUseChrome =
  !selected || sharedSteps.some(([name]) => name === "test") || localGroups.some((g) => g.length);
if (
  ok &&
  mayUseChrome &&
  !process.env.CHROME_BINARY &&
  existsSync(join(root, "node_modules/puppeteer-core"))
) {
  const { chromeBinary, INSTALL_HINT } = await import("../lib/chrome.ts");
  if (!chromeBinary()) console.error(`[scaffolding] ${INSTALL_HINT}`);
}
if (ok)
  ok = await group(
    sharedSteps,
    sync ? { catalog: "typecheck", lint: "typecheck", oxlint: "typecheck" } : {},
    new Set(Object.keys(shared).filter(quick)),
    1,
  );
for (const steps of localGroups) {
  if (!ok) break;
  order.push(...steps.map(([s]) => s));
  ok = await group(steps);
}
// The red steps again, in the gate's own order, so the verdict reads the same on every run.
const red = order.filter((name) => results.some((r) => r.name === name && r.code));
console.error(
  `[scaffolding] ${ok ? "passed" : "failed"} in ${((performance.now() - started) / 1000).toFixed(1)} s${red.length ? `: ${red.join(", ")}` : ""}`,
);
process.exit(ok ? 0 : 1);
