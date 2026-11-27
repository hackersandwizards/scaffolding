import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTermList, type TermList } from "./confidential-input.ts";
import {
  describeStaleCacheWarning,
  HOUR,
  isCachedListStale,
  isNeverCacheStale,
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
      message: `${loaded.problem}. Refused: run \`gh auth login\` with an account in the ${TERMS_REPO.split("/")[0]} trainers team, then commit again`,
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
        message: `${loaded.problem}. Refused: run \`gh auth login\` with an account in the ${TERMS_REPO.split("/")[0]} trainers team, then run it again`,
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
          "the list has no never section: Company OS has not built one, or `check-confidential fetch` fetches it now",
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
    if (result.error) return `gh: ${result.error.message}`;
    if (result.status !== 0 || !parseTermList(result.stdout)) {
      const detail = (result.stderr || result.stdout).trim().replace(/^gh: /, "").split("\n")[0];
      return `gh: ${detail || `exit ${result.status}`}`;
    }
    writeFileSync(`${this.cacheFile}.tmp`, result.stdout);
    renameSync(`${this.cacheFile}.tmp`, this.cacheFile);
    return undefined;
  }

  loadPublicRequired(explicitFile: string | undefined): LoadedTermList {
    const problem = explicitFile ? undefined : this.refreshPublicRequired();
    return this.readValidatedList(explicitFile ?? this.cacheFile, problem);
  }

  /** A hook that passes without a list tries gh at most hourly even without a copy, since gh may
   * take 20 s offline; a hook that refuses without one tries on every commit. */
  loadPublicOptional(explicitFile: string | undefined): LoadedTermList {
    const problem = explicitFile ? undefined : this.refreshPublicOptional();
    return this.readValidatedList(explicitFile ?? this.cacheFile, problem);
  }

  loadNeverRequired(explicitFile: string | undefined): LoadedTermList {
    const problem = explicitFile ? undefined : this.refreshNeverRequired();
    return this.readValidatedList(explicitFile ?? this.cacheFile, problem);
  }

  loadNeverOptional(explicitFile: string | undefined): LoadedTermList {
    const problem = explicitFile ? undefined : this.refreshNeverOptional();
    return this.readValidatedList(explicitFile ?? this.cacheFile, problem);
  }

  private fetchOrWarnFallback(): string | undefined {
    const problem = this.fetchList();
    if (problem && existsSync(this.cacheFile))
      this.onWarn(`${problem}; using the copy fetched before`);
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

  private readValidatedList(source: string, fetchProblem: string | undefined): LoadedTermList {
    const list = existsSync(source) ? parseTermList(readFileSync(source, "utf8")) : undefined;
    if (!list)
      return { problem: fetchProblem ?? `no valid list at ${source}`, absent: !existsSync(source) };
    const checked = validateTermListBuildTime(list, source, Date.now());
    if (checked.problem) return { problem: checked.problem };
    if (checked.warning) this.onWarn(checked.warning);
    return { list };
  }
}
