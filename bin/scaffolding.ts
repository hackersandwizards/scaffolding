#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readPackage, repoRoot } from "../lib/repo.ts";

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
  // One line per finding: the default formatter's table threw "Subject parameter value width" in a
  // run with findings, and a plain line format has no table. The repository's own config governs
  // every file, so a nested repository's config (a submodule's) never takes over its files and the
  // root config's ignoreFiles holds.
  styles: `bun --bun stylelint "**/*.{css,astro}"${existsSync(join(root, "stylelint.config.js")) ? " --config stylelint.config.js" : ""} --allow-empty-input --ignore-path .gitignore --formatter compact`,
  typecheck: `bun --bun ${config.typecheck ?? "tsc --noEmit"}`,
  structure: bin("check-structure"),
  coupling: bin("check-coupling"),
  "unique-names": bin("check-unique-names"),
  confidential: `${bin("check-confidential")} --tree HEAD`,
  licenses: bin("check-licenses"),
  // Tests are shared too: a gate without them is a skip someone wrote down, not one that drifted.
  test: script(config.test ?? ""),
  // The catalog build, so a broken one goes red here rather than on the Pages run.
  catalog: "bun run --silent build",
  admin: "admin-check",
};
if (!config.test && !config.skip?.test)
  fail("scaffolding.test is missing: name the tests, or skip.test with a reason");
const declared = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) };
if (!("@hackersandwizards/admin" in declared) && !config.skip?.admin)
  fail("@hackersandwizards/admin is not pinned: pin it, or skip.admin with a reason");
const skip: Record<string, string> = { ...config.skip };
if (config.private) skip.confidential ??= "scaffolding.private";
for (const [step, reason] of Object.entries(skip)) {
  if (!(step in shared)) fail(`scaffolding.skip names no shared step: ${step}`);
  if (!String(reason).trim()) fail(`scaffolding.skip.${step} has no reason`);
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

// Side by side, reported in a fixed order so the output reads the same on every run.
async function group(steps: [string, string][]): Promise<boolean> {
  const results = await Promise.all(steps.map(([n, c]) => run(n, c, steps.length > 1)));
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
if (ok) ok = await group(Object.entries(shared));
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
