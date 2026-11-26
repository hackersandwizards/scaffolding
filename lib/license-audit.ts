import { licenceAllowed } from "./licence-expression.ts";
import { isObject, isReason } from "./repo.ts";

export type LicenseException = { license?: unknown; reason?: unknown };
export type ListedPackage = { name: string; license: string; versions?: unknown[] };
export type LicenseListRun = { status: number | null; stdout: string; stderr: string };

const LIBVIPS =
  "LGPL libvips, a shared library sharp loads at build or request time on our own machines; conveyed in nothing we hand out";

export const DEFAULT_LICENSE_EXCEPTIONS: Record<string, LicenseException> = {
  "@hackersandwizards/*": { reason: "our own packages, PolyForm Strict 1.0.0" },
  "@img/sharp-libvips-*": { license: "LGPL-3.0-or-later", reason: LIBVIPS },
  "@img/sharp-win32-*": { license: "Apache-2.0 AND LGPL-3.0-or-later", reason: LIBVIPS },
  "@img/sharp-wasm32": { license: "Apache-2.0 AND LGPL-3.0-or-later AND MIT", reason: LIBVIPS },
};

export function exceptionCovers(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

export function isListedPackage(value: unknown): value is ListedPackage {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    typeof value.license === "string" &&
    (value.versions === undefined || Array.isArray(value.versions))
  );
}

export function parseListedPackages(groups: Record<string, unknown>): {
  listed: unknown[];
  packages: ListedPackage[];
} {
  const listed: unknown[] = Object.values(groups).flat();
  return { listed, packages: listed.filter(isListedPackage) };
}

function readLicenseGroups(run: LicenseListRun) {
  if (run.status !== 0) return undefined;
  const { stdout } = run;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return isObject(parsed) ? parsed : undefined;
}

export function parseLicenseCommandOutput(
  run: LicenseListRun,
  missingNeeded: () => string[] | undefined,
): { packages: ListedPackage[]; problems: string[] } {
  const problems: string[] = [];
  const groups = readLicenseGroups(run);
  if (!groups)
    return {
      packages: [],
      problems: [
        `bun pm licenses --json gave no package list (exit ${run.status}): ${`${run.stderr}`.trim()}; run bun install`,
      ],
    };
  const { listed, packages } = parseListedPackages(groups);
  if (!listed.length) problems.push("bun pm licenses lists no package: run bun install");
  if (/not installed/.test(run.stderr)) {
    const needed = missingNeeded();
    if (needed?.length !== 0)
      problems.push(
        `${run.stderr.trim()}: ${needed ? `${needed.join(", ")} needed` : "bun.lock does not read"}, run bun install`,
      );
  }
  if (packages.length < listed.length)
    problems.push(
      "bun pm licenses --json changed shape: an entry lacks a name or licence string. Check `bun --version` against packageManager in package.json, run `bun pm licenses --json` to inspect the malformed entry, and update lib/license-audit.ts if Bun changed its schema",
    );
  return { packages, problems };
}

export function validateLicenseExceptions(own: Record<string, LicenseException>): string[] {
  const problems: string[] = [];
  for (const [pattern, entry] of Object.entries(own))
    if (!isReason(entry?.reason) || typeof entry.license !== "string" || !entry.license)
      problems.push(
        `scaffolding.licenses["${pattern}"] needs a license string and a reason: set { "license": "<SPDX>", "reason": "<conveyed or not, who decided>" } in package.json, or remove the entry if the package is not needed`,
      );
  return problems;
}

export function findDisallowedPackages(
  packages: readonly ListedPackage[],
  exceptions: readonly [string, LicenseException][],
): { problems: string[]; used: Set<string> } {
  const problems: string[] = [];
  const used = new Set<string>();
  for (const pkg of packages) {
    const kept = exceptions.find(
      ([pattern, entry]) =>
        exceptionCovers(pattern, pkg.name) && (!entry.license || entry.license === pkg.license),
    );
    if (kept) used.add(kept[0]);
    else if (!licenceAllowed(pkg.license))
      problems.push(
        `${pkg.name}@${pkg.versions?.join(",")}: licence "${pkg.license}" is not on the allow list. ` +
          `Why it is installed: bun pm why ${pkg.name}. To keep it, add to package.json ` +
          `scaffolding.licenses: "${pkg.name}": { "license": ${JSON.stringify(pkg.license)}, "reason": "<conveyed or not, who decided>" }`,
      );
  }
  return { problems, used };
}

export function findUnusedLicenseExceptions(
  own: Record<string, LicenseException>,
  packages: readonly ListedPackage[],
  used: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const [pattern, entry] of Object.entries(own)) {
    if (used.has(pattern)) continue;
    const found = packages.filter((pkg) => exceptionCovers(pattern, pkg.name));
    problems.push(
      found.length
        ? `scaffolding.licenses["${pattern}"] pins "${entry?.license}", installed is "${[...new Set(found.map((pkg) => pkg.license))].join('", "')}": review the new licence with \`bun pm why ${pattern}\`, then either remove the stale entry (if the new licence is on the allow list), replace the package, or update the pinned "license" and "reason" in package.json`
        : `scaffolding.licenses["${pattern}"] matches no installed package: remove it`,
    );
  }
  return problems;
}

export function auditPackageLicenses(
  packages: readonly ListedPackage[],
  own: Record<string, LicenseException>,
): string[] {
  // A repository's own entries first, so one never reads as stale behind a default.
  const exceptions = [...Object.entries(own), ...Object.entries(DEFAULT_LICENSE_EXCEPTIONS)];
  const invalid = validateLicenseExceptions(own);
  const { problems: disallowed, used } = findDisallowedPackages(packages, exceptions);
  const unused = findUnusedLicenseExceptions(own, packages, used);
  return [...invalid, ...disallowed, ...unused];
}
