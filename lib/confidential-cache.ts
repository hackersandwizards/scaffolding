import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTermList, type TermList } from "./confidential-input.ts";
import {
  describeStaleCacheWarning,
  HOUR,
  isCachedListStale,
  isNeverCacheStale,
  termListRefresh,
  TERMS_REPO,
  validateTermListBuildTime,
} from "./confidential-terms.ts";
import type { Finding } from "./repo.ts";

export type LoadedTermList = { list?: TermList; problem?: string; absent?: boolean };

export function publicListProblemFindings(loaded: LoadedTermList): Finding[] {
  if (!loaded.problem) return [];
  return [
    {
      check: "confidential",
      path: "confidential terms",
      text: "",
      message: loaded.problem,
    },
  ];
}

export function neverListProblemFindings(loaded: LoadedTermList): Finding[] {
  if (loaded.problem) {
    return [
      {
        check: "never-shown",
        path: "confidential terms",
        text: "",
        message: loaded.problem,
      },
    ];
  }
  // A list without names to look for would pass every deck.
  if (!loaded.list?.never?.length) {
    return [
      {
        check: "never-shown",
        path: "confidential terms",
        text: "",
        message:
          "The list has no never section, so the scan has no names to check. Run `check-confidential fetch` to refresh the cache, or point --list or SCAFFOLDING_CONFIDENTIAL_TERMS at a current list with a non-empty never section.",
      },
    ];
  }
  return [];
}

function fileAgeMs(file: string): number {
  return existsSync(file) ? Date.now() - statSync(file).mtimeMs : Infinity;
}

export class ConfidentialListCache {
  private readonly cacheDir: string;
  private readonly cacheFile: string;
  private readonly attemptFile: string;
  private readonly onWarn: (message: string) => void;

  constructor(cacheDir: string, onWarn: (message: string) => void) {
    this.cacheDir = cacheDir;
    this.cacheFile = join(cacheDir, "confidential-terms.json");
    this.attemptFile = `${this.cacheFile}.attempt`;
    this.onWarn = onWarn;
  }

  /** Fetches the list into CACHE with the person's own gh login; answers why not, or undefined. */
  fetchList(): string | undefined {
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(this.attemptFile, "");
    const result = spawnSync(
      "gh",
      [
        "api",
        `repos/${TERMS_REPO}/contents/confidential-terms.json`,
        "-H",
        "Accept: application/vnd.github.raw",
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    if (result.error)
      return `gh: ${result.error.message}. The term list fetch could not start or finish, so check that gh is on PATH and the connection works before rerunning \`check-confidential fetch\`.`;
    if (result.status !== 0 || !parseTermList(result.stdout)) {
      const detail = (result.stderr || result.stdout).trim().replace(/^gh: /, "").split("\n")[0];
      const prefix = `gh: ${detail || `exit ${result.status}`}`;
      if (result.status === 0)
        return `${prefix}. The downloaded term list is invalid, so ask the list maintainer to publish a valid confidential-terms.json before rerunning \`check-confidential fetch\`.`;
      return `${prefix}. No valid term list was fetched, so ${termListRefresh}.`;
    }
    writeFileSync(`${this.cacheFile}.tmp`, result.stdout);
    renameSync(`${this.cacheFile}.tmp`, this.cacheFile);
    return undefined;
  }

  loadPublicRequired(explicitFile: string | undefined): LoadedTermList {
    const problem = explicitFile ? undefined : this.refreshPublicRequired();
    return this.readValidatedList(explicitFile, problem);
  }

  /** A hook that passes without a list tries gh at most hourly even without a copy, since gh may
   * take 20 s offline; a hook that refuses without one tries on every commit. */
  loadPublicOptional(explicitFile: string | undefined): LoadedTermList {
    const problem = explicitFile ? undefined : this.refreshPublicOptional();
    return this.readValidatedList(explicitFile, problem);
  }

  loadNeverRequired(explicitFile: string | undefined): LoadedTermList {
    const problem = explicitFile ? undefined : this.refreshNeverRequired();
    return this.readValidatedList(explicitFile, problem);
  }

  loadNeverOptional(explicitFile: string | undefined): LoadedTermList {
    const problem = explicitFile ? undefined : this.refreshNeverOptional();
    return this.readValidatedList(explicitFile, problem);
  }

  private fetchOrWarnFallback(): string | undefined {
    const problem = this.fetchList();
    if (problem && existsSync(this.cacheFile))
      this.onWarn(`${problem} Using the copy fetched before.`);
    return problem;
  }

  private refreshPublicRequired(): string | undefined {
    const age = fileAgeMs(this.cacheFile);
    if (isCachedListStale(age)) return this.refreshStaleList(age, true);
  }

  private refreshPublicOptional(): string | undefined {
    const age = fileAgeMs(this.cacheFile);
    if (isCachedListStale(age)) return this.refreshStaleList(age, false);
  }

  private isNeverStale(cacheAge: number): boolean {
    if (isCachedListStale(cacheAge)) return true;
    const cached = existsSync(this.cacheFile)
      ? parseTermList(readFileSync(this.cacheFile, "utf8"))
      : undefined;
    return isNeverCacheStale(cacheAge, cached);
  }

  private refreshNeverRequired(): string | undefined {
    const age = fileAgeMs(this.cacheFile);
    if (this.isNeverStale(age)) return this.refreshStaleList(age, true);
  }

  private refreshNeverOptional(): string | undefined {
    const age = fileAgeMs(this.cacheFile);
    if (this.isNeverStale(age)) return this.refreshStaleList(age, false);
  }

  private refreshStaleList(age: number, retryWithoutCopy: boolean): string | undefined {
    if (fileAgeMs(this.attemptFile) >= HOUR || (retryWithoutCopy && age === Infinity))
      return this.fetchOrWarnFallback();
    this.onWarn(describeStaleCacheWarning(existsSync(this.cacheFile), age));
    return undefined;
  }

  private readValidatedList(
    explicitFile: string | undefined,
    fetchProblem: string | undefined,
  ): LoadedTermList {
    const source = explicitFile ?? this.cacheFile;
    const recovery =
      explicitFile === undefined
        ? `To refresh the list, ${termListRefresh}.`
        : "Replace or rebuild the list, or remove --list and unset SCAFFOLDING_CONFIDENTIAL_TERMS to use the cache.";
    const list = existsSync(source) ? parseTermList(readFileSync(source, "utf8")) : undefined;
    if (!list) {
      return {
        problem: fetchProblem ?? `The scan needs a valid term list at ${source}. ${recovery}`,
        absent: !existsSync(source),
      };
    }
    const checked = validateTermListBuildTime(list, source, { now: Date.now(), recovery });
    if (checked.problem) return { problem: checked.problem };
    if (checked.warning) this.onWarn(checked.warning);
    return { list };
  }
}
