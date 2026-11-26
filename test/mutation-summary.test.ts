import type { MutationTestResult } from "mutation-testing-report-schema";
import { expect, test } from "vitest";
import { formatMutationSummary, mutationScorePercent } from "../lib/mutation-summary.ts";

function makeMutant(
  status: MutationTestResult["files"][string]["mutants"][number]["status"],
  location: { line: number; mutatorName: string },
  isStatic: boolean,
): MutationTestResult["files"][string]["mutants"][number] {
  return {
    id: `${location.line}-${location.mutatorName}`,
    mutatorName: location.mutatorName,
    replacement: "",
    location: {
      start: { line: location.line, column: 1 },
      end: { line: location.line, column: 2 },
    },
    status,
    static: isStatic,
  };
}

function makeReport(
  config: MutationTestResult["config"],
  files: MutationTestResult["files"],
): MutationTestResult {
  return {
    schemaVersion: "2",
    thresholds: { high: 80, low: 60 },
    config,
    files,
  };
}

test.each([
  [0, 0, "n/a"],
  [2, 4, "50.00%"],
  [1, 3, "33.33%"],
  [3, 3, "100.00%"],
] as const)("mutationScorePercent(%i, %i) returns %s", (detected, total, expected) => {
  expect(mutationScorePercent(detected, total)).toBe(expected);
});

test.each([
  ["missing config", makeReport(undefined, {}), undefined],
  ["ignoreStatic omitted from config", makeReport({}, {}), undefined],
  [
    "Timeout counts as detected, NoCoverage as undetected, and non-static Survived is excluded from the static list",
    makeReport(
      { ignoreStatic: true },
      {
        "lib/a.ts": {
          language: "ts",
          source: "",
          mutants: [
            makeMutant("Timeout", { line: 1, mutatorName: "ArithmeticOperator" }, false),
            makeMutant("NoCoverage", { line: 2, mutatorName: "BooleanLiteral" }, false),
            makeMutant("Survived", { line: 3, mutatorName: "StringLiteral" }, false),
            makeMutant("Survived", { line: 4, mutatorName: "BlockStatement" }, true),
            makeMutant("Ignored", { line: 5, mutatorName: "ConditionalExpression" }, true),
            makeMutant("CompileError", { line: 6, mutatorName: "UnaryOperator" }, false),
          ],
        },
      },
    ),
    [
      "\nNot tested against the full suite (module-level code): 1",
      "  lib/a.ts:4 BlockStatement",
      "Mutation score excluding these survivors: 33.33% (Stryker: 25.00%)",
    ].join("\n"),
  ],
  [
    "all scored mutants are static survivors",
    makeReport(
      { ignoreStatic: true },
      {
        "lib/b.ts": {
          language: "ts",
          source: "",
          mutants: [makeMutant("Survived", { line: 7, mutatorName: "ArrayDeclaration" }, true)],
        },
      },
    ),
    [
      "\nNot tested against the full suite (module-level code): 1",
      "  lib/b.ts:7 ArrayDeclaration",
      "Mutation score excluding these survivors: n/a (Stryker: 0.00%)",
    ].join("\n"),
  ],
  [
    "empty report produces n/a for both scores",
    makeReport({ ignoreStatic: true }, {}),
    [
      "\nNot tested against the full suite (module-level code): 0",
      "Mutation score excluding these survivors: n/a (Stryker: n/a)",
    ].join("\n"),
  ],
] as const)("formatMutationSummary handles %s", (_, report, expected) => {
  expect(formatMutationSummary(report)).toBe(expected);
});
