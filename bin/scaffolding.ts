#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { isReason, readPackage, repoRoot, styleFiles, stylelintFlags } from "../lib/repo.ts";

const KEYS = new Set([
  "allow",
  "private",
  "typecheck",
  "uniqueNames",
  "test",
  "skip",
  "check",
  "styles",
  "licenses",
]);

if (process.argv[2] !== "check") {
  console.error("usage: scaffolding check");
  process.exit(2);
}
const root = repoRoot();
const home = join(import.meta.dir, "..");
if (!process.env.SCAFFOLDING_LOCKED) {
  const run = spawnSync(
    process.execPath,
    [join(home, "bin/check-lock.ts"), process.execPath, import.meta.path, "check"],
    { stdio: "inherit", cwd: root, env: { ...process.env, SCAFFOLDING_LOCKED: "1" } },
  );
  process.exit(run.status ?? 1);
}

const pkg = readPackage(root);
const config = pkg.scaffolding ?? {};
const fail = (message: string): never => {
  console.error(`[scaffolding] ${message}`);
  process.exit(1);
};
for (const key of Object.keys(config)) if (!KEYS.has(key)) fail(`unknown key scaffolding.${key}`);

const script = (s: string) => (pkg.scripts?.[s] ? `bun run --silent ${s}` : s);
const bin = (name: string) => `bun ${join(home, "bin", `${name}.ts`)}`;
const shared: Record<string, string> = {
  format: "bun --bun prettier --check --log-level warn .",
  lint: "bun --bun eslint --cache --concurrency=auto .",
  styles: `bun --bun stylelint "${styleFiles}" ${stylelintFlags(root).join(" ")}`,
  typecheck: `bun --bun ${config.typecheck ?? "tsc --noEmit"}`,
  structure: bin("check-structure"),
  coupling: bin("check-coupling"),
  "unique-names": bin("check-unique-names"),
  spaces: bin("check-spaces"),
  confidential: `${bin("check-confidential")} --tree HEAD`,
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
const declared = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) };
if (!("@hackersandwizards/admin" in declared) && !isReason(config.skip?.admin))
  fail("@hackersandwizards/admin is not pinned: pin it, or skip.admin with a reason");
const skip = { ...config.skip };
// A private repository's shipped files reach only company readers.
if (config.private === true) {
  skip.confidential ??= "scaffolding.private";
  skip.history ??= "scaffolding.private";
}
for (const [step, reason] of Object.entries(skip)) {
  if (!(step in shared)) fail(`scaffolding.skip names no shared step: ${step}`);
  if (!isReason(reason)) fail(`scaffolding.skip.${step} has no reason`);
  delete shared[step];
}

const env = { ...process.env, PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}` };
type Result = { name: string; code: number; ms: number; out: string };

function run(name: string, line: string, buffered: boolean): Promise<Result> {
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn("sh", ["-c", line], {
      cwd: root,
      env,
      stdio: buffered ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("close", (code) =>
      done({ name, code: code ?? 1, ms: performance.now() - started, out }),
    );
  });
}

// Side by side, reported in a fixed order so the output reads the same on every run. A step named
// in `after` starts once the step it names, listed before it, has finished, passed or failed.
async function group(
  steps: [string, string][],
  after: Record<string, string> = {},
): Promise<boolean> {
  const buffered = steps.length > 1;
  const runs = new Map<string, Promise<Result>>();
  for (const [n, c] of steps) {
    const first = runs.get(after[n] ?? "");
    runs.set(n, first ? first.then(() => run(n, c, buffered)) : run(n, c, buffered));
  }
  const results = await Promise.all(runs.values());
  for (const r of results) {
    process.stderr.write(r.out);
    console.error(
      `[scaffolding] ${r.code ? "FAIL" : "ok  "} ${r.name} ${(r.ms / 1000).toFixed(1)} s`,
    );
  }
  return results.every((r) => r.code === 0);
}

const started = performance.now();
// Install first: a tree a pin-raising merge left behind gets installed, and a lockfile out of step
// fails under its own name, not a later step's.
let ok = await group([["install", "bun install --frozen-lockfile"]]);
// A typecheck of `astro check` and the catalog's `astro build` both run Astro's sync, whose Vite
// server optimizes dependencies into one folder (node_modules/.astro/vite-sync). On a cache an
// install invalidated, two at once race on its rename and one fails with ENOTEMPTY, so the catalog
// build waits for the typecheck.
if (ok) ok = await group(Object.entries(shared), { catalog: "typecheck" });
for (const entry of config.check ?? []) {
  if (!ok) break;
  const steps = (Array.isArray(entry) ? entry : [entry]).map((s): [string, string] => [
    s,
    script(s),
  ]);
  ok = await group(steps);
}
console.error(
  `[scaffolding] ${ok ? "passed" : "failed"} in ${((performance.now() - started) / 1000).toFixed(1)} s`,
);
process.exit(ok ? 0 : 1);
