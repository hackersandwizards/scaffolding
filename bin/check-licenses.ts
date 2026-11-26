#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditPackageLicenses,
  parseLicenseCommandOutput,
  type LicenseException,
} from "../lib/license-audit.ts";
import { isObject, isStrings, readPackage, repoRoot } from "../lib/repo.ts";

type Deps = Record<string, string>;
type Meta = {
  dependencies?: Deps;
  devDependencies?: Deps;
  peerDependencies?: Deps;
  optionalPeers?: string[];
};

function licenseLockText(file: string): string | undefined {
  if (!lstatSync(file, { throwIfNoEntry: false })) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function licenseLockMeta(value: unknown): value is Meta {
  return (
    isObject(value) &&
    ["dependencies", "devDependencies", "peerDependencies"].every(
      (field) => value[field] === undefined || isObject(value[field]),
    ) &&
    (value.optionalPeers === undefined || isStrings(value.optionalPeers))
  );
}

function parseLicenseLock(text: string | undefined) {
  if (text === undefined) return undefined;
  let lock: unknown;
  try {
    lock = Bun.JSONC.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isObject(lock) || !isObject(lock.workspaces) || !isObject(lock.packages)) return undefined;
  const workspaces = Object.values(lock.workspaces);
  if (!workspaces.every(licenseLockMeta)) return undefined;
  return { workspaces, packages: lock.packages };
}

/** The bun.lock entries missing from node_modules that the root or an installed package needs, by
 * Node's lookup (its own node_modules first, then each parent's). bun also skips an entry only a
 * left-out platform package needs, such as Tailwind's oxide-wasm32-wasi, which uses its bundled
 * copies. Optional dependencies may be absent. Undefined when bun.lock does not read. */
function neededMissing(root: string): string[] | undefined {
  const lock = parseLicenseLock(licenseLockText(join(root, "bun.lock")));
  if (!lock) return undefined;
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
    lock.workspaces.flatMap((ws) => [...needs(ws), ...Object.keys(ws.devDependencies ?? {})]),
  );
  let read = 0;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!installed(key)) continue;
    if (!Array.isArray(entry)) return undefined;
    const meta: unknown = entry.find((v) => v && typeof v === "object");
    if (meta !== undefined && !licenseLockMeta(meta)) return undefined;
    const dependencies = needs(meta);
    for (const name of dependencies) needed.add(resolve(key, name));
    read += dependencies.length;
  }
  // No dependency read off any installed entry means the lock did not read as expected.
  if (!read) return undefined;
  return [...needed].filter((key) => Object.hasOwn(lock.packages, key) && !installed(key)).sort();
}

function checkLicenses() {
  const started = performance.now();
  const root = repoRoot();
  const done = (problems: string[]): never => {
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
  const { packages, problems } = parseLicenseCommandOutput(run, () => neededMissing(root));
  if (problems.length) done(problems);

  const own: Record<string, LicenseException> = readPackage(root).scaffolding?.licenses ?? {};
  done(auditPackageLicenses(packages, own));
}

if (import.meta.main) checkLicenses();
