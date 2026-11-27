import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  ConfidentialListCache,
  neverListProblemFindings,
  publicListProblemFindings,
} from "../lib/confidential-cache.ts";
import { DAY } from "../lib/confidential-terms.ts";

function makeListJson(overrides: { built?: string; never?: string[] } = {}): string {
  return JSON.stringify({
    built: overrides.built ?? new Date().toISOString(),
    salt: "0123456789abcdef",
    maxTokens: 2,
    hashes: ["aaaa"],
    never: overrides.never,
  });
}

test("ConfidentialListCache.loadPublicRequired reads explicit valid and missing files", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-cache-"));
  try {
    const warnings: string[] = [];
    const cache = new ConfidentialListCache(dir, (msg) => warnings.push(msg));
    const listFile = join(dir, "terms.json");
    writeFileSync(listFile, makeListJson());
    const ok = cache.loadPublicRequired(listFile);
    expect(ok.list?.hashes).toEqual(["aaaa"]);
    expect(warnings).toEqual([]);

    const missing = cache.loadPublicRequired(join(dir, "missing.json"));
    expect(missing).toEqual({
      problem: `The scan needs a valid term list at ${join(dir, "missing.json")}. Supply a current list through --list or SCAFFOLDING_CONFIDENTIAL_TERMS, or run \`check-confidential fetch\` to refresh the cache.`,
      absent: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConfidentialListCache.loadPublicOptional warns instead of refetching within the hour", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-opt-"));
  try {
    const warnings: string[] = [];
    const cache = new ConfidentialListCache(dir, (msg) => warnings.push(msg));
    const cacheFile = join(dir, "confidential-terms.json");
    const attemptFile = `${cacheFile}.attempt`;
    writeFileSync(cacheFile, makeListJson());
    writeFileSync(attemptFile, "");
    const twoDaysAgo = new Date(Date.now() - 2 * DAY);
    utimesSync(cacheFile, twoDaysAgo, twoDaysAgo);

    const loaded = cache.loadPublicOptional(undefined);
    expect(loaded.list?.hashes).toEqual(["aaaa"]);
    expect(warnings).toEqual(["copy older than a day; next fetch within the hour"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConfidentialListCache.loadNeverRequired warns when cached copy lacks a never section and attempt is recent", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-never-"));
  try {
    const warnings: string[] = [];
    const cache = new ConfidentialListCache(dir, (msg) => warnings.push(msg));
    const cacheFile = join(dir, "confidential-terms.json");
    const attemptFile = `${cacheFile}.attempt`;
    writeFileSync(cacheFile, makeListJson());
    writeFileSync(attemptFile, "");

    const loaded = cache.loadNeverRequired(undefined);
    expect(loaded.list?.hashes).toEqual(["aaaa"]);
    expect(warnings).toEqual(["copy without a never section; next fetch within the hour"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function withIsolatedPath(binDir: string, run: () => void): void {
  const originalPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    run();
  } finally {
    process.env.PATH = originalPath;
  }
}

test("ConfidentialListCache.loadNeverOptional warns without fetching when no cache exists and attempt is recent", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-never-opt-"));
  try {
    const warnings: string[] = [];
    const cache = new ConfidentialListCache(dir, (msg) => warnings.push(msg));
    const cacheFile = join(dir, "confidential-terms.json");
    writeFileSync(`${cacheFile}.attempt`, "");

    withIsolatedPath(dir, () => {
      const loaded = cache.loadNeverOptional(undefined);
      expect(loaded).toEqual({
        problem: `The scan needs a valid term list at ${cacheFile}. To refresh the list, run \`gh auth login\` with an account in the hackersandwizards trainers team, then run \`check-confidential fetch\`.`,
        absent: true,
      });
    });
    expect(warnings).toEqual([
      "no copy; next fetch within the hour, or now by `check-confidential fetch`",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConfidentialListCache required loaders fetch when cache is absent even after a recent attempt", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-req-absent-"));
  try {
    const cache = new ConfidentialListCache(dir, () => undefined);
    const cacheFile = join(dir, "confidential-terms.json");
    writeFileSync(`${cacheFile}.attempt`, "");

    withIsolatedPath(dir, () => {
      const neverLoaded = cache.loadNeverRequired(undefined);
      expect(neverLoaded.problem).toContain("gh:");
      expect(neverLoaded.absent).toBe(true);
      const publicLoaded = cache.loadPublicRequired(undefined);
      expect(publicLoaded.problem).toContain("gh:");
      expect(publicLoaded.absent).toBe(true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConfidentialListCache.fetchList returns a gh error when gh is unavailable on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-fetch-"));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = dir;
    const cache = new ConfidentialListCache(dir, () => undefined);
    const problem = cache.fetchList();
    expect(problem).toMatch(
      /^gh: .+\. The term list fetch could not start or finish, so check that gh is on PATH and the connection works before rerunning `check-confidential fetch`\.$/,
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  ["loadPublicRequired", publicListProblemFindings],
  ["loadNeverRequired", neverListProblemFindings],
] as const)("%s reports how to regain access to the term list", (load, findings) => {
  const dir = mkdtempSync(join(tmpdir(), "conf-fetch-denied-"));
  try {
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nprintf 'gh: HTTP 404: Not Found\\n' >&2\nexit 1\n", {
      mode: 0o755,
    });
    const cache = new ConfidentialListCache(dir, () => undefined);
    withIsolatedPath(dir, () => {
      const loaded = cache[load](undefined);
      expect(findings(loaded)[0].message).toBe(
        "gh: HTTP 404: Not Found. No valid term list was fetched, so run `gh auth login` with an account in the hackersandwizards trainers team, then run `check-confidential fetch`.",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("neverListProblemFindings requires a never section while the public scan does not", () => {
  expect(publicListProblemFindings({ list: { salt: "s", maxTokens: 1, hashes: [] } })).toEqual([]);
  expect(
    neverListProblemFindings({ list: { salt: "s", maxTokens: 1, hashes: [] } })[0].message,
  ).toBe(
    "The list has no never section, so the scan has no names to check. Run `check-confidential fetch` to refresh the cache, or point --list or SCAFFOLDING_CONFIDENTIAL_TERMS at a current list with a non-empty never section.",
  );
  expect(
    neverListProblemFindings({ list: { salt: "s", maxTokens: 1, hashes: [], never: ["h"] } }),
  ).toEqual([]);
});

test("ConfidentialListCache.fetchList rejects an invalid response from gh", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-fetch-invalid-"));
  try {
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nprintf 'unexpected response'\n", { mode: 0o755 });
    const cache = new ConfidentialListCache(dir, () => undefined);
    withIsolatedPath(dir, () => {
      expect(cache.fetchList()).toBe(
        "gh: unexpected response. The downloaded term list is invalid, so ask the list maintainer to publish a valid confidential-terms.json before rerunning `check-confidential fetch`.",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
