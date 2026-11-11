#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
// Raises every @hackersandwizards/* Git pin to the newest v<version> tag of its remote, in
// dependency order, installing after each; then runs the gate once and reports per package. With
// --commit, a green gate commits package.json, bun.lock and what check-structure --fix wrote.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { help } from "../lib/help.ts";
import { git, newestTag, readPackage, repoRoot, underLock, withoutEnvFile } from "../lib/repo.ts";

help("raise-pins");
withoutEnvFile("raise-pins");
const args = process.argv.slice(2).filter((arg) => arg !== "--locked");
if (args.some((arg) => arg !== "--commit")) {
  console.error("usage: raise-pins [--commit]");
  process.exit(2);
}
const root = repoRoot();
process.chdir(root);
// No gate or build reads node_modules while an install rewrites it; the gate run below takes the
// lock at once.
await underLock(root, args);

const say = (line: string) => console.log(`[raise-pins] ${line}`);
const succeeds = (command: string[]) =>
  spawnSync(command[0]!, command.slice(1), { stdio: "inherit" }).status === 0;
// Paths with a change against HEAD, untracked ones included.
const changed = () =>
  new Set(
    git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], root)
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3)),
  );
const MANIFESTS = ["package.json", "bun.lock"];
if (!existsSync("bun.lock")) {
  say("no bun.lock: run bun install and commit it first");
  process.exit(1);
}
if (MANIFESTS.some((path) => changed().has(path))) {
  say("package.json or bun.lock holds an uncommitted change: commit or revert it first");
  process.exit(1);
}

const PIN = /^(git\+[^#]+)#v(\d+\.\d+\.\d+)$/;
const FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const pkg = readPackage(root);
const pins = FIELDS.flatMap((field) =>
  Object.entries((pkg[field] ?? {}) as Record<string, string>).flatMap(([name, spec]) => {
    const pin = name.startsWith("@hackersandwizards/") ? PIN.exec(spec) : null;
    return pin ? [{ name, spec, url: pin[1]!, from: `v${pin[2]}` }] : [];
  }),
);

// A package goes after the pinned packages its installed version depends on, so each install
// resolves it against what is already raised.
const needs = (name: string) => {
  const own = readPackage(join(root, "node_modules", name));
  return Object.keys({ ...own.dependencies, ...(own.peerDependencies as object) });
};
const ordered: typeof pins = [];
for (let rest = pins; rest.length;) {
  const ready = rest.filter((pin) =>
    needs(pin.name).every((dep) => !rest.some((other) => other !== pin && other.name === dep)),
  );
  // A cycle takes the rest in the order package.json lists them.
  const next = ready.length ? ready : rest;
  ordered.push(...next);
  rest = rest.filter((pin) => !next.includes(pin));
}

// Read side by side: each read may wait its full bound.
const newest = await Promise.all(ordered.map(({ url }) => newestTag(url.slice("git+".length))));
const raised: string[] = [];
const paths = new Set(MANIFESTS);
// A pin kept at its version leaves the others' raise whole. A skeleton half written, a file of
// someone else's that --fix rewrote, or node_modules not put back blocks the commit.
let failed = false;
let blocked = false;
for (const [at, { name, spec, url, from }] of ordered.entries()) {
  const to = newest[at];
  if (!to) {
    say(`${name}: no v<version> tag read from ${url} (above), kept ${from}`);
    failed = true;
    continue;
  }
  if (Bun.semver.order(to.slice(1), from.slice(1)) <= 0) {
    say(`${name}: ${from}, the newest`);
    continue;
  }
  const kept = MANIFESTS.map((path) => [path, readFileSync(path)] as const);
  const text = kept[0]![1].toString();
  const pinned = `${JSON.stringify(name)}: ${JSON.stringify(spec)}`;
  if (!text.includes(pinned)) {
    say(`${name}: package.json does not hold ${pinned} as written, kept ${from}`);
    failed = true;
    continue;
  }
  writeFileSync(
    "package.json",
    text.replace(pinned, () => `${JSON.stringify(name)}: ${JSON.stringify(`${url}#${to}`)}`),
  );
  if (!succeeds(["bun", "install"])) {
    for (const [path, bytes] of kept) writeFileSync(path, bytes);
    if (!succeeds(["bun", "install", "--frozen-lockfile"])) {
      say("node_modules not put back (above): run bun install --frozen-lockfile");
      blocked = true;
    }
    say(`${name}: ${to} did not install (above), kept ${from}`);
    failed = true;
    continue;
  }
  say(`${name}: ${from} -> ${to}`);
  raised.push(`${name.slice("@hackersandwizards/".length)} ${to}`);
  // A raise of this package brings its skeleton files, which the commit takes with it.
  if (name !== "@hackersandwizards/scaffolding") continue;
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
  const before = new Map([...changed()].map((path) => [path, read(path)]));
  if (!succeeds(["bun", "run", "check-structure", "--fix"])) blocked = failed = true;
  for (const path of changed())
    if (!before.has(path)) paths.add(path);
    else if (before.get(path) !== read(path)) {
      say(`check-structure --fix rewrote ${path}, which held an uncommitted change`);
      blocked = failed = true;
    }
}

if (!raised.length) {
  say("nothing raised, so the gate did not run");
  process.exit(failed ? 1 : 0);
}
const green = succeeds(["bun", "run", "check"]);
say(`gate ${green ? "green" : "red (above)"} with ${raised.join(", ")}`);
if (args.includes("--commit")) {
  const message = `pins: raise ${raised.join(", ")}`;
  const list = [...paths];
  if (!green || blocked)
    say("nothing committed: package.json and bun.lock keep the raise until committed or reverted");
  else if (
    succeeds(["git", "add", "--", ...list]) &&
    succeeds(["git", "commit", "-qm", message, "--", ...list])
  )
    say(`committed "${message}"`);
  else {
    // Staged paths left behind would go into another session's next commit.
    succeeds(["git", "restore", "--staged", "--", ...list]);
    say("the commit failed (above): the raise stays uncommitted");
    failed = true;
  }
}
process.exit(green && !failed ? 0 : 1);
