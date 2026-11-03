#!/usr/bin/env bun
// Every installed package's licence is on the allow list of permissive licences, or an exception
// pins its exact licence string with a reason. The package list is bun's own `bun pm licenses
// --json` (every package of bun.lock in node_modules, Git tags included, offline). An SPDX `OR`
// passes when one side passes, an `AND` only when every side does, `WITH` keeps the base licence;
// a string that does not parse (`Unknown`, `SEE LICENSE IN …`, a URL) is not allowed. Fail closed:
// a bun error, output that is not the expected JSON, or zero packages listed is red.
//
//   "scaffolding": {
//     "licenses": {
//       "elkjs": { "license": "EPL-2.0", "reason": "dev only, never conveyed; decided by …" },
//       "@acme/*": { "license": "…", "reason": "…" }
//     }
//   }
//
// A repository's entry without a reason, matching no installed package, or whose licence string no
// longer matches is red. The defaults below may match nothing.
import { spawnSync } from "node:child_process";
import { readPackage, repoRoot } from "../lib/repo.ts";

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

type Exception = { license?: string; reason?: string };
const LIBVIPS =
  "LGPL libvips, a shared library sharp loads at build or request time on our own machines; conveyed in nothing we hand out";
const DEFAULTS: Record<string, Exception> = {
  "@hackersandwizards/*": { reason: "our own packages, PolyForm Strict 1.0.0" },
  "@img/sharp-libvips-*": { license: "LGPL-3.0-or-later", reason: LIBVIPS },
  "@img/sharp-win32-*": { license: "Apache-2.0 AND LGPL-3.0-or-later", reason: LIBVIPS },
  "@img/sharp-wasm32": { license: "Apache-2.0 AND LGPL-3.0-or-later AND MIT", reason: LIBVIPS },
};

/** True when the SPDX expression passes the allow list, false when it fails or does not parse. */
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
  if (/not installed/.test(run.stderr)) problems.push(`${run.stderr.trim()}: run bun install`);
  if (packages.some((p) => typeof p?.name !== "string" || typeof p?.license !== "string"))
    problems.push("bun pm licenses --json changed shape: an entry lacks a name or licence string");
  if (problems.length) done();

  const own: Record<string, Exception> = readPackage(root).scaffolding?.licenses ?? {};
  for (const [pattern, e] of Object.entries(own))
    if (!e?.reason?.trim() || !e.license)
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
