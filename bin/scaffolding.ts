#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { help } from "../lib/help.ts";
import {
  isReason,
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

help("scaffolding");
withoutEnvFile("scaffolding");

// Every key of the Package type's scaffolding and no other, or typecheck fails.
const KEYS = new Set(
  Object.keys({
    allow: 0,
    private: 0,
    typecheck: 0,
    uniqueNames: 0,
    test: 0,
    skip: 0,
    check: 0,
    styles: 0,
    licenses: 0,
    changed: 0,
  } satisfies Record<keyof NonNullable<Package["scaffolding"]>, 0>),
);

const args = process.argv.slice(2).filter((a) => a !== "--locked");
const changed = args[1] === "--changed";
const ranges = args.slice(2);
if (
  args[0] !== "check" ||
  (!changed && args.length > 1) ||
  ranges.some((r) => !/^[^.\s]+\.\.[^.\s]+$/.test(r))
) {
  console.error("usage: scaffolding check [--changed [<from>..<to>...]]");
  process.exit(2);
}
const root = repoRoot();
const home = join(import.meta.dir, "..");
await underLock(root, args);

const pkg = readPackage(root);
const config = pkg.scaffolding ?? {};
const fail = (message: string): never => {
  console.error(`[scaffolding] ${message}`);
  process.exit(1);
};
for (const key of Object.keys(config)) if (!KEYS.has(key)) fail(`unknown key scaffolding.${key}`);

const script = (s: string) => (pkg.scripts?.[s] ? `bun run --silent ${s}` : s);
// Quoted for `sh -c`: a package path holding a space failed every bin step.
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const bin = (name: string) => `bun ${quote(join(home, "bin", `${name}.ts`))}`;
// A submodule is its own repository's to check: format, lint and styles walk past it.
const submodules = submodulePaths(root).map((path) => quote(`${path}/**`));
const ignored = submodules.map((p) => ` --ignore-pattern ${p}`).join("");
const shared: Record<string, string> = {
  format: `bun --bun prettier --check --cache --log-level warn .${submodules.map((p) => ` '!'${p}`).join("")}`,
  lint: `bun --bun eslint --cache --concurrency=auto .${ignored}`,
  styles: `bun --bun stylelint "${styleFiles}" ${stylelintFlags(root).join(" ")}${ignored}`,
  typecheck: `bun --bun ${config.typecheck ?? "tsc --noEmit"}`,
  structure: bin("check-structure"),
  coupling: bin("check-coupling"),
  "unique-names": bin("check-unique-names"),
  spaces: bin("check-spaces"),
  // The index: what the next commit holds, judged by its own allow list.
  confidential: `${bin("check-confidential")} --index`,
  history: bin("check-history"),
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
// The build is the repository's own, so its step names the folders: brand-retired over what it writes.
const branded = "@hackersandwizards/brand" in declared;
if (
  branded &&
  !(config.check ?? []).flat().includes("check:retired") &&
  !isReason(config.skip?.retired)
)
  fail(
    "@hackersandwizards/brand is pinned and scaffolding.check runs no check:retired: add it (brand-retired <build folders>), or skip.retired with a reason",
  );
const skip = { ...config.skip };
// A private repository's shipped files reach only company readers.
if (config.private === true) {
  skip.history ??= "scaffolding.private";
}
for (const [step, reason] of Object.entries(skip)) {
  if (!(step in shared) && !(step === "retired" && branded))
    fail(`scaffolding.skip names no shared step: ${step}`);
  if (!isReason(reason)) fail(`scaffolding.skip.${step} has no reason`);
  delete shared[step];
}

// scaffolding.changed maps a path glob to the steps a change there needs. Every step it names
// exists, so a typo goes red on the whole gate too, not only where --changed would skip it.
const named = new Set([
  ...Object.keys(shared),
  ...Object.keys(skip),
  ...(config.check ?? []).flat(),
]);
for (const [glob, steps] of Object.entries(config.changed ?? {}))
  for (const step of Array.isArray(steps) ? steps : [steps])
    if (!named.has(step)) fail(`scaffolding.changed["${glob}"] names no step: ${step}`);

// --changed runs the quick shared checks and the steps scaffolding.changed maps the changed paths
// to: those of the ranges given (the pre-push hook passes each pushed branch), else the commits not
// yet on the upstream, staged and unstaged changes and untracked files. The whole gate runs where a
// path maps to no step, where it is a file every step reads, where a range starts a new branch or
// at a commit this clone lacks, and where git cannot list the changes.
const WHOLE = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "**/tsconfig*.json",
  "**/eslint.config.*",
  "**/prettier.config.*",
  "**/.prettierrc*",
  ".prettierignore",
  "**/stylelint.config.*",
  "**/astro.config.*",
];
// The hub's rules and skill prose, which no step but the quick shared ones reads. Skill code and
// data stay unmapped: a repository's own checks may read them, such as brand-colours a skill's JSON.
const QUICK = [".claude/rules/**", ".claude/skills/**/*.md", ".claude/skills/**/*.{yaml,yml}"];
const selected = changed ? changedSteps() : undefined;
function changedSteps(): Set<string> | undefined {
  const whole = (why: string) =>
    void console.error(`[scaffolding] --changed: ${why}: the whole gate runs`);
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  const lists: string[] = [];
  let since = "HEAD";
  if (ranges.length) {
    for (const range of ranges) {
      const [from, to] = range.split("..") as [string, string];
      if (/^0+$/.test(from)) return whole(`${range} starts a new branch`);
      const base = git("merge-base", from, to);
      if (base.status) return whole(`${range} starts at a commit this clone lacks`);
      const diff = git("diff", "--name-only", "--no-renames", "-z", base.stdout.trim(), to);
      if (diff.status) return whole("git could not list the changes");
      lists.push(diff.stdout);
    }
    since = ranges.map((r) => r.split("..")[0]!.slice(0, 9)).join(", ");
  } else {
    const upstream = git("rev-parse", "--verify", "-q", "@{upstream}").stdout.trim();
    const base = upstream ? git("merge-base", upstream, "HEAD").stdout.trim() : "HEAD";
    const diff = git("diff", "--name-only", "--no-renames", "-z", base);
    const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
    if (!base || diff.status || untracked.status) return whole("git could not list the changes");
    lists.push(diff.stdout, untracked.stdout);
    if (upstream) since = upstream.slice(0, 9);
  }
  const paths = [...new Set(lists.join("").split("\0").filter(Boolean))];
  const steps = new Set<string>();
  const match = (path: string) => (g: string) => new Bun.Glob(g).match(path);
  for (const path of paths) {
    if (WHOLE.some(match(path))) return whole(`${path} is read by every step`);
    const hits = Object.entries(config.changed ?? {}).filter(([g]) => match(path)(g));
    if (!hits.length && !QUICK.some(match(path)))
      return whole(`${path} maps to no step in scaffolding.changed`);
    for (const [, s] of hits) for (const step of s) steps.add(step);
  }
  console.error(`[scaffolding] --changed: ${paths.length} paths since ${since}`);
  return steps;
}
// A step --changed leaves out says so, so the skip leaves a trace.
const runs = (name: string) => {
  if (!selected || selected.has(name)) return true;
  console.error(`[scaffolding] skipped ${name}: no changed path maps to it`);
  return false;
};

const { load, cores, factor } = machineLoad();
// A test runner's per-test limit (bun's and vitest's default 5 s), stretched as serve's wait is;
// the repository's test command passes it on, since the gate cannot add a flag to any runner.
const env = {
  ...process.env,
  PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}`,
  SCAFFOLDING_TEST_TIMEOUT_MS: String(Math.round(5000 * factor)),
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
    `[scaffolding] load ${Math.round(load)} on ${cores} cores: test and catalog run one after another, the repository's steps ${width} at a time`,
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

// Install first: a tree a pin-raising merge left behind gets installed, and a lockfile out of step
// fails under its own name, not a later step's.
let ok = await group([["install", "bun install --frozen-lockfile"]]);
// Steps that found no Chrome for Testing each installed it into the shared cache at once, and the
// downloads collided; so where the repository pins puppeteer-core its build is installed here once.
if (ok && !process.env.CHROME_BINARY && existsSync(join(root, "node_modules/puppeteer-core"))) {
  const { chromeBinary, INSTALL_HINT } = await import("../lib/chrome.ts");
  if (!chromeBinary()) console.error(`[scaffolding] ${INSTALL_HINT}`);
}
// A typecheck of `astro check` and the catalog's `astro build` both run Astro's sync, whose Vite
// server optimizes dependencies into one folder (node_modules/.astro/vite-sync). On a cache an
// install invalidated, two at once race on its rename and one fails with ENOTEMPTY, so the catalog
// build waits for a typecheck that runs Astro. A plain tsc shares no folder with it.
// `bun --bun <name>` runs a package script of that name before a binary.
const typecheck = config.typecheck ?? "";
const sync = /\bastro\b/.test(
  [typecheck, ...typecheck.split(/\s+/).map((word) => pkg.scripts?.[word])].join(" "),
);
const quick = (name: string) => name !== "test" && name !== "catalog";
const order = Object.keys(shared);
if (ok)
  ok = await group(
    Object.entries(shared).filter(([name]) => quick(name) || runs(name)),
    sync ? { catalog: "typecheck" } : {},
    new Set(Object.keys(shared).filter(quick)),
    1,
  );
for (const entry of config.check ?? []) {
  if (!ok) break;
  const steps = (Array.isArray(entry) ? entry : [entry])
    .filter(runs)
    .map((s): [string, string] => [s, script(s)]);
  order.push(...steps.map(([s]) => s));
  ok = await group(steps);
}
// The red steps again, in the gate's own order, so the verdict reads the same on every run.
const red = order.filter((name) => results.some((r) => r.name === name && r.code));
console.error(
  `[scaffolding] ${ok ? "passed" : "failed"} in ${((performance.now() - started) / 1000).toFixed(1)} s${red.length ? `: ${red.join(", ")}` : ""}`,
);
process.exit(ok ? 0 : 1);
