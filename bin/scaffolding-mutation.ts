#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { readFileSync, statSync } from "node:fs";
import type { MutationTestResult } from "mutation-testing-report-schema";
import { help } from "../lib/help.ts";
import { runTimed } from "../lib/run-timed.ts";

const reportPath = ".stryker-reports/mutation.json";

function mutationReportStamp() {
  return statSync(reportPath, { bigint: true, throwIfNoEntry: false })?.ctimeNs;
}

function printMutationSummary() {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as MutationTestResult;
  if (!report.config || !("ignoreStatic" in report.config) || report.config.ignoreStatic !== true)
    return;

  const survivors: string[] = [];
  let detected = 0;
  let undetected = 0;
  for (const [file, { mutants }] of Object.entries(report.files)) {
    for (const mutant of mutants) {
      if (mutant.status === "Killed" || mutant.status === "Timeout") detected++;
      if (mutant.status === "Survived" || mutant.status === "NoCoverage") undetected++;
      if (mutant.status === "Survived" && mutant.static === true)
        survivors.push(`  ${file}:${mutant.location.start.line} ${mutant.mutatorName}`);
    }
  }

  const total = detected + undetected;
  const score = (count: number) => (count ? `${((detected / count) * 100).toFixed(2)}%` : "n/a");
  console.log(
    [
      `\nNot tested against the full suite (module-level code): ${survivors.length}`,
      ...survivors,
      `Mutation score excluding these survivors: ${score(total - survivors.length)} (Stryker: ${score(total)})`,
    ].join("\n"),
  );
}

export function runMutation(
  command: [string, ...string[]],
  limitMs = 15 * 60_000,
  env?: NodeJS.ProcessEnv,
) {
  return runTimed(command, {
    name: "scaffolding-mutation",
    limitMs,
    env,
    timeoutMessage:
      "Mutation testing reached its 15-minute wall limit. Narrow the run with --mutate <files>.",
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (process.env.SCAFFOLDING_MUTATION_WORKER === "1") {
    // The Vitest runner must load Vite before Stryker installs its stack-trace hook on Bun.
    await import("@stryker-mutator/vitest-runner");
    const { StrykerCli } = await import("@stryker-mutator/core");
    process.title = "stryker";
    new StrykerCli([process.execPath, "stryker", "run", ...args]).run();
  } else {
    help("scaffolding-mutation");
    const previousReport = mutationReportStamp();
    process.exitCode =
      process.env.SCAFFOLDING_MUTATION_BUN === "1"
        ? await runMutation(
            [process.execPath, "--no-env-file", import.meta.path, ...args],
            undefined,
            {
              ...process.env,
              SCAFFOLDING_MUTATION_WORKER: "1",
            },
          )
        : await runMutation(["stryker", "run", ...args]);
    const report = mutationReportStamp();
    if (report !== undefined && report !== previousReport) printMutationSummary();
  }
}
