#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isReason, readPackage, repoRoot } from "../lib/repo.ts";

const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Python-2.0",
  "PSF-2.0",
  "Unlicense",
  "Zlib",
  "WTFPL",
  "OFL-1.1",
  "MPL-2.0",
]);

type Exception = { license?: unknown; reason?: unknown };
const LIBVIPS =
  "LGPL libvips, a shared library sharp loads at build or request time on our own machines; conveyed in nothing we hand out";
const DEFAULTS: Record<string, Exception> = {
  "@hackersandwizards/*": { reason: "our own packages, PolyForm Strict 1.0.0" },
  "@img/sharp-libvips-*": { license: "LGPL-3.0-or-later", reason: LIBVIPS },
  "@img/sharp-win32-*": { license: "Apache-2.0 AND LGPL-3.0-or-later", reason: LIBVIPS },
  "@img/sharp-wasm32": { license: "Apache-2.0 AND LGPL-3.0-or-later AND MIT", reason: LIBVIPS },
};

function licenceAllowed(expression: string): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const fail = () => {
    throw new Error(expression);
  };
  const atom = (): boolean => {
    const token = tokens[at++];
    if (token === "(") {
      const value = or();
      if (tokens[at++] !== ")") fail();
      return value;
    }
    if (!token || /^(AND|OR|WITH|\))$/.test(token)) fail();
    if (tokens[at] === "WITH" && /^(AND|OR|WITH|\(|\))?$/.test(tokens[(at += 2) - 1] ?? "")) fail();
    return ALLOWED.has(token);
  };
  const and = (): boolean => {
    let value = atom();
    while (tokens[at] === "AND") {
      at++;
      value = atom() && value;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (tokens[at] === "OR") {
      at++;
      value = and() || value;
    }
    return value;
  };
  try {
    const value = or();
    return at === tokens.length && value;
  } catch {
    return false;
  }
}

const exceptionCovers = (pattern: string, name: string) =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;

type Deps = Record<string, string>;
type Meta = { dependencies?: Deps; peerDependencies?: Deps; optionalPeers?: string[] };

/** The bun.lock entries missing from node_modules that the root or an installed package needs, by
 * Node's lookup (its own node_modules first, then each parent's). bun also skips an entry only a
 * left-out platform package needs, such as Tailwind's oxide-wasm32-wasi, which uses its bundled
 * copies. Optional dependencies may be absent. Undefined when bun.lock does not read. */
function neededMissing(root: string): string[] | undefined {
  try {
    const lock = Bun.JSONC.parse(readFileSync(join(root, "bun.lock"), "utf8")) as {
      workspaces: Record<string, Meta & { devDependencies?: Deps }>;
      packages: Record<string, unknown[]>;
    };
    // A key names the package and each package it sits under: "a/@s/b" is a/node_modules/@s/b.
    const names = (key: string): string[] => key.match(/(?:@[^/]+\/)?[^/]+/g) ?? [];
    const installed = (key: string) =>
      existsSync(join(root, ...names(key).flatMap((n) => ["node_modules", n])));
    const resolve = (from: string, name: string) => {
      for (let at = names(from); at.length; at = at.slice(0, -1))
        if (`${at.join("/")}/${name}` in lock.packages) return `${at.join("/")}/${name}`;
      return name;
    };
    const needs = (meta: Meta | undefined) => [
      ...Object.keys(meta?.dependencies ?? {}),
      ...Object.keys(meta?.peerDependencies ?? {}).filter((p) => !meta?.optionalPeers?.includes(p)),
    ];
    const needed = new Set(
      Object.values(lock.workspaces).flatMap((ws) => [
        ...needs(ws),
        ...Object.keys(ws.devDependencies ?? {}),
      ]),
    );
    let read = 0;
    for (const [key, entry] of Object.entries(lock.packages))
      if (installed(key))
        for (const name of needs(entry.find((v) => v && typeof v === "object") as Meta)) {
          needed.add(resolve(key, name));
          read++;
        }
    // No dependency read off any installed entry means the lock did not read as expected.
    if (!read) return undefined;
    return [...needed].filter((key) => key in lock.packages && !installed(key)).sort();
  } catch {
    return undefined;
  }
}

function checkLicenses() {
  const started = performance.now();
  const root = repoRoot();
  const problems: string[] = [];
  const done = () => {
    for (const p of problems) console.error(`[check-licenses] ${p}`);
    const ms = Math.round(performance.now() - started);
    if (problems.length) console.error(`[check-licenses] ${problems.length} findings, ${ms} ms`);
    process.exit(problems.length ? 1 : 0);
  };

  const run = spawnSync(process.execPath, ["--no-env-file", "pm", "licenses", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: Infinity,
  });
  let groups: Record<string, { name?: unknown; license?: unknown; versions?: unknown }[]> = {};
  try {
    if (run.status !== 0) throw new Error();
    groups = JSON.parse(run.stdout);
    if (!groups || typeof groups !== "object" || Array.isArray(groups)) throw new Error();
  } catch {
    problems.push(
      `bun pm licenses --json gave no package list (exit ${run.status}): ${`${run.stderr}`.trim()}; run bun install`,
    );
    done();
  }
  const packages = Object.values(groups).flat();
  if (!packages.length) problems.push("bun pm licenses lists no package: run bun install");
  if (/not installed/.test(run.stderr)) {
    const needed = neededMissing(root);
    if (needed?.length !== 0)
      problems.push(
        `${run.stderr.trim()}: ${needed ? `${needed.join(", ")} needed` : "bun.lock does not read"}, run bun install`,
      );
  }
  if (packages.some((p) => typeof p?.name !== "string" || typeof p?.license !== "string"))
    problems.push("bun pm licenses --json changed shape: an entry lacks a name or licence string");
  if (problems.length) done();

  const own: Record<string, Exception> = readPackage(root).scaffolding?.licenses ?? {};
  for (const [pattern, e] of Object.entries(own))
    if (!isReason(e?.reason) || typeof e.license !== "string" || !e.license)
      problems.push(`scaffolding.licenses["${pattern}"] needs a license string and a reason`);
  // A repository's own entries first, so one never reads as stale behind a default.
  const exceptions = [...Object.entries(own), ...Object.entries(DEFAULTS)];
  const used = new Set<string>();

  for (const p of packages as { name: string; license: string; versions?: string[] }[]) {
    const kept = exceptions.find(
      ([pattern, e]) => exceptionCovers(pattern, p.name) && (!e.license || e.license === p.license),
    );
    if (kept) used.add(kept[0]);
    else if (!licenceAllowed(p.license))
      problems.push(
        `${p.name}@${p.versions?.join(",")}: licence "${p.license}" is not on the allow list. ` +
          `Why it is installed: bun pm why ${p.name}. To keep it, add to package.json ` +
          `scaffolding.licenses: "${p.name}": { "license": ${JSON.stringify(p.license)}, "reason": "<conveyed or not, who decided>" }`,
      );
  }
  for (const [pattern, e] of Object.entries(own)) {
    if (used.has(pattern)) continue;
    const found = (packages as { name: string; license: string }[]).filter((p) =>
      exceptionCovers(pattern, p.name),
    );
    problems.push(
      found.length
        ? `scaffolding.licenses["${pattern}"] pins "${e?.license}", installed is "${[...new Set(found.map((p) => p.license))].join('", "')}"`
        : `scaffolding.licenses["${pattern}"] matches no installed package: remove it`,
    );
  }
  done();
}

if (import.meta.main) checkLicenses();
