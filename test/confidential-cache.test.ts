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
      problem: `no valid list at ${join(dir, "missing.json")}`,
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

test("ConfidentialListCache.fetchList returns a gh error when gh is unavailable on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-fetch-"));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = dir;
    const cache = new ConfidentialListCache(dir, () => undefined);
    const problem = cache.fetchList();
    expect(problem).toContain("gh:");
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publicListProblemFindings and neverListProblemFindings build refusal findings", () => {
  expect(publicListProblemFindings({ list: { salt: "s", maxTokens: 1, hashes: [] } })).toEqual([]);
  expect(publicListProblemFindings({ problem: "no list" })[0].message).toContain(
    "then commit again",
  );
  expect(neverListProblemFindings({ problem: "no list" })[0].message).toContain(
    "then run it again",
  );
  expect(
    neverListProblemFindings({ list: { salt: "s", maxTokens: 1, hashes: [] } })[0].message,
  ).toContain("the list has no never section");
  expect(
    neverListProblemFindings({ list: { salt: "s", maxTokens: 1, hashes: [], never: ["h"] } }),
  ).toEqual([]);
});
