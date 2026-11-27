#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  collectRangeChanges,
  collectRangeChangesWithShell,
  collectWorkingTreeChanges,
  collectWorkingTreeChangesWithShell,
} from "../lib/changed-paths.ts";
import { allChangedSteps, ChangedStepSelector, fastSteps } from "../lib/changed-steps.ts";
import { browserTestProblem, pinsPackage, placedSteps, vitestRun } from "../lib/gate-config.ts";
import * as gatePlan from "../lib/gate-plan.ts";
import { GateStepRunner, stepConcurrencyLimit } from "../lib/gate-runner.ts";
import { help } from "../lib/help.ts";
import { ownEntry } from "../lib/own-entry.ts";
import { isReason, readPackage, repoRoot, underLock, withoutEnvFile } from "../lib/repo.ts";
import { machineLoad } from "../lib/serve.ts";

const directChecks = [
  "shell",
  "python",
  "terraform",
  "dockerfile",
  "workflows",
  "duplicates",
  "unused",
];
const usage =
  "usage: scaffolding check [--changed [<from>..<to>...]] | scaffolding <shell|python|terraform|dockerfile|workflows|duplicates|unused> | scaffolding markdown [--fix] | scaffolding layers [--write] | scaffolding test [<vitest args>...] | scaffolding fix";
help("scaffolding", usage);
withoutEnvFile("scaffolding");

function fail(message: string): never {
  console.error(`[scaffolding] ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => a !== "--locked");
const changed = args[1] === "--changed";
const ranges = args.slice(2);
const [command, ...commandArgs] = args;
const fix = command === "fix" && commandArgs.length === 0;
if (fix) {
  for (const flags of [
    ["eslint", "--cache", "--concurrency=auto", ".", "--fix"],
    ["prettier", "--write", "."],
  ]) {
    const run = spawnSync(process.execPath, ["--bun", ...flags], { stdio: "inherit" });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
}
if (command === "test") {
  const config = readPackage(repoRoot()).scaffolding ?? {};
  const problem = browserTestProblem(config);
  if (problem || !config.browserTest)
    fail(
      problem ??
        "scaffolding test needs a folder to exclude from Vitest. Set scaffolding.browserTest in package.json to the repository-relative browser test folder.",
    );
  const run = spawnSync(
    process.execPath,
    [...vitestRun, "--exclude", `${config.browserTest}/**`, ...commandArgs],
    { stdio: "inherit" },
  );
  process.exit(run.status ?? 1);
}
function runDirectCheck(step: string, flags: string[]) {
  const run = spawnSync(
    process.execPath,
    ["--no-env-file", join(import.meta.dir, `check-${step}.ts`), ...flags],
    { stdio: "inherit" },
  );
  return run.status ?? 1;
}

if (fix) {
  const markdown = runDirectCheck("markdown", ["--fix"]);
  if (markdown) process.exit(markdown);
  const skip = readPackage(repoRoot()).scaffolding?.skip ?? {};
  const python = Object.hasOwn(skip, "python") ? 0 : runDirectCheck("python", ["--fix"]);
  const terraform = Object.hasOwn(skip, "terraform") ? 0 : runDirectCheck("terraform", ["--fix"]);
  process.exit(python || terraform);
}

const direct =
  (command !== undefined && directChecks.includes(command) && commandArgs.length === 0) ||
  (command === "layers" &&
    (commandArgs.length === 0 || (commandArgs.length === 1 && commandArgs[0] === "--write"))) ||
  (command === "markdown" &&
    (commandArgs.length === 0 || (commandArgs.length === 1 && commandArgs[0] === "--fix")));
if (direct) process.exit(runDirectCheck(command, commandArgs));
if (
  command !== "check" ||
  (!changed && args.length > 1) ||
  ranges.some((r) => !/^(?:(?!\.\.)\S)+\.\.(?!\.)(?:(?!\.\.)\S)+$/.test(r))
) {
  console.error(
    "[scaffolding] Invalid scaffolding invocation. Use the command and argument forms below, or run scaffolding --help for details.",
  );
  console.error(usage);
  process.exit(2);
}
const root = repoRoot();
const home = join(import.meta.dir, "..");
await underLock(root, args);

const pkg = readPackage(root);
const config = pkg.scaffolding ?? {};
const configProblem =
  gatePlan.validateConfigKeys(config) ??
  gatePlan.validateRequiredGateFields(pkg) ??
  gatePlan.validateGateIntegrations(pkg);
if (configProblem) fail(configProblem);

const plan = new gatePlan.GatePlan(gatePlan.buildSharedStepMap(pkg, root, home));
const { shared, full, replacements } = plan;
const skip = { ...config.skip };
const entries = (config.check ?? []).flat();
const local = entries.filter((step) => !placedSteps.has(step));

const brandErr = plan.addBrandSteps(pkg, home);
if (brandErr) fail(brandErr);

const checkReplacement = (step: string) => {
  const { replacement, problem } = gatePlan.resolveLocalReplacement(step, local, pkg.scripts);
  if (problem) fail(problem);
  if (replacement) replacements.set(step, replacement);
  return Boolean(replacement);
};
if (pinsPackage(pkg, "@hackersandwizards/slides") && !checkReplacement("pins"))
  shared.pins = "slides-pins";
if (config.server && !checkReplacement("links") && entries.includes("links"))
  full.set(
    "links",
    gatePlan.withServerCommand(
      home,
      config.server,
      [
        gatePlan.scaffoldingBinCommand(home, "check-links"),
        "{url}",
        ...(config.linkSkips ?? []).map((prefix) => `--skip ${gatePlan.shellQuote(prefix)}`),
      ].join(" "),
    ),
  );
if (config.browserTest)
  full.set("browser-test", `bun ${vitestRun.join(" ")} ${gatePlan.shellQuote(config.browserTest)}`);

const named = new Set([...Object.keys(shared), ...full.keys(), ...local]);
for (const [step, reason] of Object.entries(skip)) {
  if (step === "oxlint" || !(Object.hasOwn(shared, step) || full.has(step)))
    fail(
      `scaffolding.skip cannot skip ${step} because it is not a skippable shared step. Remove the entry from package.json or use a documented skip key from scaffolding's docs/gate.md.`,
    );
  if (!isReason(reason))
    fail(
      `scaffolding.skip.${step} has no valid reason for skipping the step. Set it to a non-blank string in package.json.`,
    );
  named.add(step);
  delete shared[step];
  full.delete(step);
  if (step === "lint") delete shared.oxlint;
}

const unusedKey = plan.unusedConfigKey(config);
if (unusedKey)
  fail(
    `scaffolding.${unusedKey} has no effect with the configured steps. Remove it from package.json or enable a step that uses it as described in scaffolding's docs/gate.md.`,
  );
const placedErr = gatePlan.validatePlacedStepEntries(entries, replacements, named);
if (placedErr) fail(placedErr);
for (const [step, replacement] of replacements)
  console.error(`[scaffolding] ${step} uses local ${replacement}`);

const fullOnlyBuilt = gatePlan.buildFullOnlyMap(config, local);
if (fullOnlyBuilt.problem !== undefined) fail(fullOnlyBuilt.problem);
const fullOnly = fullOnlyBuilt.fullOnly;

const mappingsBuilt = gatePlan.buildChangedMappings(config, named);
if (mappingsBuilt.problem !== undefined) fail(mappingsBuilt.problem);
const mappings = mappingsBuilt.mappings;

const fast = fastSteps([...Object.keys(shared), ...local], fullOnly);
const changedStepSelector = new ChangedStepSelector(fast, local, mappings);

function resolveChangedSteps(): Map<string, string> {
  const collected = ranges.length
    ? fast.has("shell")
      ? collectRangeChangesWithShell(root, ranges)
      : collectRangeChanges(root, ranges)
    : fast.has("shell")
      ? collectWorkingTreeChangesWithShell(root)
      : collectWorkingTreeChanges(root);
  if ("fallback" in collected) {
    console.error(`[scaffolding] --changed: ${collected.fallback}: all fast steps run`);
    return allChangedSteps(fast, collected.fallback);
  }
  const { steps, fallback: why } = changedStepSelector.select(collected);
  if (why !== undefined) console.error(`[scaffolding] --changed: ${why}: all fast steps run`);
  else
    console.error(
      `[scaffolding] --changed: ${collected.paths.size} paths since ${collected.since}`,
    );
  return steps;
}

const { load, cores, factor } = machineLoad();
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
const width = stepConcurrencyLimit(load, cores);
if (Number.isFinite(width))
  console.error(
    `[scaffolding] load ${Math.round(load)} on ${cores} cores: ${changed ? "test runs after the other shared steps" : "test and catalog run one after another"}, the repository's steps ${width} at a time`,
  );

const started = performance.now();
const runner = new GateStepRunner(root, env, width);
runner.installSignalHandlers();

// A typecheck of `astro check` and the catalog's `astro build` both run Astro's sync, whose Vite
// server optimizes dependencies into one folder (node_modules/.astro/vite-sync). On a cache an
// install invalidated, two at once race on its rename and one fails with ENOTEMPTY, so the catalog
// build waits for a typecheck that runs Astro. A plain tsc shares no folder with it. Lint waits
// for it too: the sync writes the content types (.astro/), and without them the typed rules read
// every content entry as `any` (1,724 findings against 899 in one fresh checkout).
const sync = gatePlan.usesAstroTypecheck(config.typecheck ?? "", pkg.scripts);
const selected = changed ? resolveChangedSteps() : undefined;
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
const unplacedShared = Object.entries(shared).filter(
  ([name]) => !placedSteps.has(name) || !entries.includes(name),
);
const sharedSteps = unplacedShared.filter(([name]) => runs(name));
const localGroups = (config.check ?? []).map((entry) =>
  (Array.isArray(entry) ? entry : [entry])
    .filter((name) => !placedSteps.has(name) || full.has(name) || Object.hasOwn(shared, name))
    .filter(runs)
    .map((s): [string, string] => [
      s,
      full.get(s) ??
        (placedSteps.has(s) ? ownEntry(shared, s) : undefined) ??
        gatePlan.packageScriptCommand(pkg.scripts, s),
    ]),
);
localGroups.unshift([...full].filter(([name]) => !entries.includes(name) && runs(name)));
const quick = (name: string) => name !== "test" && name !== "catalog";
const order = unplacedShared.map(([name]) => name);

// Install first: a tree a pin-raising merge left behind gets installed, and a lockfile out of step
// fails under its own name, not a later step's.
let ok = await runner.runParallel([["install", "bun install --frozen-lockfile"]]);
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
  ok = await runner.runOrdered(
    sharedSteps,
    sync ? { catalog: "typecheck", lint: "typecheck", oxlint: "typecheck" } : {},
    new Set(Object.keys(shared).filter(quick)),
  );
for (const steps of localGroups) {
  if (!ok) break;
  order.push(...steps.map(([s]) => s));
  ok = await runner.runParallel(steps);
}
const red = order.filter((name) => runner.results.some((r) => r.name === name && r.code));
console.error(
  `[scaffolding] ${ok ? "passed" : "failed"} in ${((performance.now() - started) / 1000).toFixed(1)} s${red.length ? `: ${red.join(", ")}` : ""}`,
);
process.exit(ok ? 0 : 1);
