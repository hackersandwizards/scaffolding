import { failParsingInput } from "./json-parse-fault.ts";
import { expect, test } from "vitest";
import {
  auditPackageLicenses,
  exceptionCovers,
  findDisallowedPackages,
  findUnusedLicenseExceptions,
  isListedPackage,
  parseLicenseCommandOutput,
  parseListedPackages,
  validateLicenseExceptions,
  type LicenseException,
} from "../lib/license-audit.ts";

test.each([
  ["pkg", "pkg", true],
  ["pkg", "pkg-extra", false],
  ["@scope/*", "@scope/a", true],
  ["@scope/*", "@other/a", false],
  ["prefix-*", "prefix-", true],
] as const)("exceptionCovers(%s, %s) is %s", (pattern, name, expected) => {
  expect(exceptionCovers(pattern, name)).toBe(expected);
});

test.each([
  [{ name: "a", license: "MIT", versions: ["1.0.0"] }, true],
  [{ name: "a", license: "MIT" }, true],
  [{ name: "a", license: "MIT", versions: "1.0.0" }, false],
  [{ name: 1, license: "MIT" }, false],
  [{ name: "a" }, false],
  [null, false],
] as const)("isListedPackage(%j) is %s", (value, expected) => {
  expect(isListedPackage(value)).toBe(expected);
});

test.each([
  [
    { MIT: [{ name: "a", license: "MIT" }, { bad: true }], ISC: [{ name: "b", license: "ISC" }] },
    3,
    [
      { name: "a", license: "MIT" },
      { name: "b", license: "ISC" },
    ],
  ],
  [{}, 0, []],
] as const)(
  "parseListedPackages flattens groups and filters valid entries",
  (groups, count, valid) => {
    const result = parseListedPackages(groups);
    expect(result.listed).toHaveLength(count);
    expect(result.packages).toEqual(valid);
  },
);

test.each([
  {
    label: "non-zero exit",
    run: { status: 1, stdout: "{}", stderr: "boom\n" },
    missing: undefined,
    expectedProblems: [
      "bun pm licenses --json gave no package list (exit 1): boom; run bun install",
    ],
  },
  {
    label: "invalid JSON",
    run: { status: 0, stdout: "{bad", stderr: "" },
    missing: undefined,
    expectedProblems: ["bun pm licenses --json gave no package list (exit 0): ; run bun install"],
  },
  {
    label: "non-object JSON",
    run: { status: 0, stdout: "[]", stderr: "" },
    missing: undefined,
    expectedProblems: ["bun pm licenses --json gave no package list (exit 0): ; run bun install"],
  },
  {
    label: "empty package list",
    run: { status: 0, stdout: "{}", stderr: "" },
    missing: undefined,
    expectedProblems: ["bun pm licenses lists no package: run bun install"],
  },
  {
    label: "not installed with missing needed packages",
    run: {
      status: 0,
      stdout: '{"MIT":[{"name":"a","license":"MIT"}]}',
      stderr: "1 package not installed\n",
    },
    missing: ["foo", "bar"],
    expectedProblems: ["1 package not installed: foo, bar needed, run bun install"],
  },
  {
    label: "not installed when bun.lock does not read",
    run: {
      status: 0,
      stdout: '{"MIT":[{"name":"a","license":"MIT"}]}',
      stderr: "1 package not installed\n",
    },
    missing: undefined,
    expectedProblems: ["1 package not installed: bun.lock does not read, run bun install"],
  },
  {
    label: "not installed when zero needed packages are missing",
    run: {
      status: 0,
      stdout: '{"MIT":[{"name":"a","license":"MIT"}]}',
      stderr: "1 package not installed\n",
    },
    missing: [],
    expectedProblems: [],
  },
  {
    label: "malformed entry in groups",
    run: { status: 0, stdout: '{"MIT":[{"name":"a"}]}', stderr: "" },
    missing: undefined,
    expectedProblems: [
      "bun pm licenses --json changed shape: an entry lacks a name or licence string. Check `bun --version` against packageManager in package.json, run `bun pm licenses --json` to inspect the malformed entry, and update lib/license-audit.ts if Bun changed its schema",
    ],
  },
])("parseLicenseCommandOutput handles $label", ({ run, missing, expectedProblems }) => {
  const result = parseLicenseCommandOutput(run, () => missing);
  expect(result.problems).toEqual(expectedProblems);
});

test.each([
  [{ a: { license: "GPL-3.0-only", reason: "approved by lead" } }, []],
  [
    { a: { license: "GPL-3.0-only", reason: "   " } },
    [
      'scaffolding.licenses["a"] needs a license string and a reason: set { "license": "<SPDX>", "reason": "<conveyed or not, who decided>" } in package.json, or remove the entry if the package is not needed',
    ],
  ],
  [
    { b: { license: "", reason: "approved" } },
    [
      'scaffolding.licenses["b"] needs a license string and a reason: set { "license": "<SPDX>", "reason": "<conveyed or not, who decided>" } in package.json, or remove the entry if the package is not needed',
    ],
  ],
] as const)("validateLicenseExceptions checks %j", (own, expected) => {
  expect(validateLicenseExceptions(own)).toEqual(expected);
});

test.each([
  {
    label: "allowed SPDX",
    packages: [{ name: "ok", license: "MIT", versions: ["1.0.0"] }],
    exceptions: [] as [string, { license?: unknown; reason?: unknown }][],
    expectedProblems: [],
    expectedUsed: [],
  },
  {
    label: "disallowed SPDX",
    packages: [{ name: "copyleft", license: "GPL-3.0-only", versions: ["1.0.0", "2.0.0"] }],
    exceptions: [] as [string, { license?: unknown; reason?: unknown }][],
    expectedProblems: [
      'copyleft@1.0.0,2.0.0: licence "GPL-3.0-only" is not on the allow list. Why it is installed: bun pm why copyleft. To keep it, add to package.json scaffolding.licenses: "copyleft": { "license": "GPL-3.0-only", "reason": "<conveyed or not, who decided>" }',
    ],
    expectedUsed: [],
  },
  {
    label: "matching exception",
    packages: [{ name: "copyleft", license: "GPL-3.0-only", versions: ["1.0.0"] }],
    exceptions: [["copyleft", { license: "GPL-3.0-only", reason: "kept" }]] as [
      string,
      { license?: unknown; reason?: unknown },
    ][],
    expectedProblems: [],
    expectedUsed: ["copyleft"],
  },
  {
    label: "mismatched license pin",
    packages: [{ name: "copyleft", license: "AGPL-3.0-only", versions: ["1.0.0"] }],
    exceptions: [["copyleft", { license: "GPL-3.0-only", reason: "kept" }]] as [
      string,
      { license?: unknown; reason?: unknown },
    ][],
    expectedProblems: [
      'copyleft@1.0.0: licence "AGPL-3.0-only" is not on the allow list. Why it is installed: bun pm why copyleft. To keep it, add to package.json scaffolding.licenses: "copyleft": { "license": "AGPL-3.0-only", "reason": "<conveyed or not, who decided>" }',
    ],
    expectedUsed: [],
  },
])(
  "findDisallowedPackages evaluates $label",
  ({ packages, exceptions, expectedProblems, expectedUsed }) => {
    const result = findDisallowedPackages(packages, exceptions);
    expect(result.problems).toEqual(expectedProblems);
    expect([...result.used]).toEqual(expectedUsed);
  },
);

test.each<{
  label: string;
  own: Record<string, LicenseException>;
  packages: { name: string; license: string }[];
  used: Set<string>;
  expected: string[];
}>([
  {
    label: "used exception is skipped",
    own: { kept: { license: "GPL-3.0-only", reason: "ok" } },
    packages: [{ name: "kept", license: "GPL-3.0-only" }],
    used: new Set(["kept"]),
    expected: [],
  },
  {
    label: "unmatched exception",
    own: { gone: { license: "GPL-3.0-only", reason: "ok" } },
    packages: [],
    used: new Set<string>(),
    expected: ['scaffolding.licenses["gone"] matches no installed package: remove it'],
  },
  {
    label: "stale license pin deduplicates installed licences",
    own: { changed: { license: "GPL-3.0-only", reason: "ok" } },
    packages: [
      { name: "changed", license: "MIT" },
      { name: "changed", license: "MIT" },
    ],
    used: new Set<string>(),
    expected: [
      'scaffolding.licenses["changed"] pins "GPL-3.0-only", installed is "MIT": review the new licence with `bun pm why changed`, then either remove the stale entry (if the new licence is on the allow list), replace the package, or update the pinned "license" and "reason" in package.json',
    ],
  },
])("findUnusedLicenseExceptions handles $label", ({ own, packages, used, expected }) => {
  expect(findUnusedLicenseExceptions(own, packages, used)).toEqual(expected);
});

test("auditPackageLicenses prefers own exception over defaults", () => {
  const result = auditPackageLicenses(
    [{ name: "@hackersandwizards/brand", license: "SEE LICENSE IN LICENSE" }],
    {
      "@hackersandwizards/brand": {
        license: "SEE LICENSE IN LICENSE",
        reason: "explicit pin",
      },
    },
  );
  expect(result).toEqual([]);
});

test("auditPackageLicenses reports invalid, disallowed, then unused findings in order", () => {
  const ordered = auditPackageLicenses(
    [{ name: "bad-pkg", license: "GPL-3.0-only", versions: ["1.0.0"] }],
    {
      invalid: { license: "", reason: "" },
      absent: { license: "GPL-3.0-only", reason: "old" },
    },
  );
  expect(ordered).toHaveLength(4);
  expect(ordered[0]).toContain('scaffolding.licenses["invalid"] needs a license string');
  expect(ordered[1]).toContain("bad-pkg@1.0.0");
  expect(ordered[2]).toContain('scaffolding.licenses["invalid"] matches no installed package');
  expect(ordered[3]).toContain('scaffolding.licenses["absent"] matches no installed package');
});

test("licence command output propagates unexpected parser failures", () => {
  const stdout = '{"MIT":[{"name":"example","license":"MIT"}]}';
  const failure = new RangeError("licence output parser failed");
  using _parse = failParsingInput(stdout, failure);
  expect(() => parseLicenseCommandOutput({ status: 0, stdout, stderr: "" }, () => [])).toThrow(
    failure,
  );
});
