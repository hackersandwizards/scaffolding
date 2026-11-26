import type { MutationTestResult } from "mutation-testing-report-schema";

const DETECTED_STATUSES = new Set(["Killed", "Timeout"]);
const UNDETECTED_STATUSES = new Set(["Survived", "NoCoverage"]);

export function mutationScorePercent(detected: number, total: number): string {
  return total ? `${((detected / total) * 100).toFixed(2)}%` : "n/a";
}

export function formatMutationSummary(report: MutationTestResult): string | undefined {
  if (!report.config || !("ignoreStatic" in report.config) || report.config.ignoreStatic !== true)
    return undefined;

  const survivors: string[] = [];
  let detected = 0;
  let undetected = 0;
  for (const [file, { mutants }] of Object.entries(report.files)) {
    for (const mutant of mutants) {
      if (DETECTED_STATUSES.has(mutant.status)) detected++;
      if (UNDETECTED_STATUSES.has(mutant.status)) undetected++;
      if (mutant.status === "Survived" && mutant.static === true)
        survivors.push(`  ${file}:${mutant.location.start.line} ${mutant.mutatorName}`);
    }
  }

  const total = detected + undetected;
  const excluding = mutationScorePercent(detected, total - survivors.length);
  const stryker = mutationScorePercent(detected, total);
  return [
    `\nNot tested against the full suite (module-level code): ${survivors.length}`,
    ...survivors,
    `Mutation score excluding these survivors: ${excluding} (Stryker: ${stryker})`,
  ].join("\n");
}
