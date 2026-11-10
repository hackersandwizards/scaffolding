#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  isReason,
  readPackage,
  repoRoot,
  styleFiles,
  stylelintFlags,
  withoutEnvFile,
  type Package,
} from "../lib/repo.ts";
import { machineLoad } from "../lib/serve.ts";

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
  } satisfies Record<keyof NonNullable<Package["scaffolding"]>, 0>),
);

if (process.argv[2] !== "check") {
  console.error("usage: scaffolding check");
  process.exit(2);
}
const root = repoRoot();
const home = join(import.meta.dir, "..");
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
// The run check-lock starts carries --locked and goes on to the checks. A signal here goes on to
// check-lock, which passes it to the locked run's group and holds the lock until that group is
// empty: ending this process alone left the gate running and the lock held.
if (process.argv[3] !== "--locked") {
  const lock = spawn(
    process.execPath,
    [join(home, "bin/check-lock.ts"), process.execPath, import.meta.path, "check", "--locked"],
    // A group of its own: a terminal's Ctrl-C reaches this process alone, which passes it on once;
    // reaching check-lock as well, the second copy read as a second signal and killed the gate.
    { stdio: "inherit", cwd: root, detached: true },
  );
  for (const signal of SIGNALS) process.on(signal, () => lock.kill(signal));
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done) =>
    lock.on("exit", (...end) => done(end)),
  );
  // Dying by the signal tells the calling shell it was an interrupt.
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
  process.exit(code ?? 1);
}

const pkg = readPackage(root);
const config = pkg.scaffolding ?? {};
const fail = (message: string): never => {
  console.error(`[scaffolding] ${message}`);
  process.exit(1);
};
for (const key of Object.keys(config)) if (!KEYS.has(key)) fail(`unknown key scaffolding.${key}`);

const script = (s: string) => (pkg.scripts?.[s] ? `bun run --silent ${s}` : s);
// Quoted for `sh -c`: a package path holding a space failed every bin step.
const bin = (name: string) => `bun '${join(home, "bin", `${name}.ts`).replaceAll("'", `'\\''`)}'`;
const shared: Record<string, string> = {
  format: "bun --bun prettier --check --cache --log-level warn .",
  lint: "bun --bun eslint --cache --concurrency=auto .",
  styles: `bun --bun stylelint "${styleFiles}" ${stylelintFlags(root).join(" ")}`,
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

const { load, cores, factor } = machineLoad();
// A test runner's per-test limit (bun's and vitest's default 5 s), stretched as serve's wait is;
// the repository's test command passes it on, since the gate cannot add a flag to any runner.
const env = {
  ...process.env,
  PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}`,
  SCAFFOLDING_TEST_TIMEOUT_MS: String(Math.round(5000 * factor)),
};
type Result = { name: string; code: number; ms: number };

// Above one waiting process per core, the tests, the build and the repository's own steps run one
// after another, once the quick shared checks have run side by side: started all at once on a
// loaded machine, they starved each other past every fixed limit inside them, and a correct tree
// went red.
const serial = load > cores;
if (serial)
  console.error(
    `[scaffolding] load ${Math.round(load)} on ${cores} cores: test, catalog and the repository's steps run one after another`,
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
// or failed. Under load only the steps named in `quick` still run side by side.
async function group(
  steps: [string, string][],
  after: Record<string, string> = {},
  quick = new Set<string>(),
): Promise<boolean> {
  const runs = new Map<string, Promise<Result>>();
  const start = (n: string, c: string, buffered: boolean) => {
    const first = runs.get(after[n] ?? "");
    runs.set(n, first ? first.then(() => run(n, c, buffered)) : run(n, c, buffered));
  };
  const alone = serial ? steps.filter(([n]) => !quick.has(n)) : [];
  const beside = steps.filter((step) => !alone.includes(step));
  for (const [n, c] of beside) start(n, c, steps.length > 1);
  if (alone.length) await Promise.all(runs.values());
  // One at a time, a step writes straight to the terminal.
  for (const [n, c] of alone) {
    start(n, c, false);
    await runs.get(n);
  }
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
const order = Object.keys(shared);
if (ok)
  ok = await group(
    Object.entries(shared),
    sync ? { catalog: "typecheck" } : {},
    new Set(Object.keys(shared).filter((name) => name !== "test" && name !== "catalog")),
  );
for (const entry of config.check ?? []) {
  if (!ok) break;
  const steps = (Array.isArray(entry) ? entry : [entry]).map((s): [string, string] => [
    s,
    script(s),
  ]);
  order.push(...steps.map(([s]) => s));
  ok = await group(steps);
}
// The red steps again, in the gate's own order, so the verdict reads the same on every run.
const red = order.filter((name) => results.some((r) => r.name === name && r.code));
console.error(
  `[scaffolding] ${ok ? "passed" : "failed"} in ${((performance.now() - started) / 1000).toFixed(1)} s${red.length ? `: ${red.join(", ")}` : ""}`,
);
process.exit(ok ? 0 : 1);
