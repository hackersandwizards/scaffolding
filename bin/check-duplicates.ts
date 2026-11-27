#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { runJscpd } from "jscpd";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eslintIgnorePatterns } from "../config/eslint-ignores.js";
import { runTrackedLint } from "../lib/extra-lint.ts";
import { renderGuides } from "../lib/guides.ts";
import { lintPathExemptions } from "../lib/lint-path-exemptions.ts";
import { oxlintConfig, parseOxlintConfig } from "../lib/oxlint-restrictions.ts";
import { scaffoldingCache } from "../lib/pinned-binary.ts";
import { productionCode } from "../lib/production-code.ts";
import { jsonObject, isObject, printCheckFindings, type Finding } from "../lib/repo.ts";
import { regularInput } from "../lib/tracked-inputs.ts";

function cloneLocation(file: unknown) {
  if (
    !isObject(file) ||
    typeof file.name !== "string" ||
    typeof file.start !== "number" ||
    typeof file.end !== "number"
  )
    throw new Error("jscpd returned a clone without a source location");
  return `${file.name}:${file.start}-${file.end}`;
}

function reportDuplicateBlocks(directory: string) {
  const { duplicates } = jsonObject(readFileSync(join(directory, "jscpd-report.json"), "utf8"));
  if (!Array.isArray(duplicates)) throw new Error("jscpd did not return a clone list");
  const clones = (duplicates as unknown[]).filter((clone) => {
    if (!isObject(clone) || typeof clone.lines !== "number" || typeof clone.tokens !== "number")
      throw new Error("jscpd returned a clone without a line or token count");
    if (clone.lines < 5 || clone.tokens < 50) return false;
    console.error(
      `[duplicates] ${cloneLocation(clone.firstFile)} duplicates ${cloneLocation(clone.secondFile)}`,
    );
    return true;
  });
  if (clones.length) process.stderr.write(renderGuides(["duplicated-block"]));
  else console.log("[duplicates] no duplicated blocks");
  return Number(clones.length > 0);
}

function scanDuplicateBlocks(directory: string) {
  const config = join(directory, ".jscpd.json");
  writeFileSync(config, "{}");
  // jscpd compares end - start. The JSON report counts both endpoints.
  const run = runJscpd(
    [
      "--config",
      config,
      "--min-lines",
      "4",
      "--min-tokens",
      "50",
      "--reporters",
      "json",
      "--no-colors",
      "--no-gitignore",
      "--no-tips",
      "--output",
      directory,
      "sources",
    ],
    { cwd: directory, encoding: "utf8" },
  );
  if (run.error) throw run.error;
  if (run.status === null) throw new Error(`jscpd terminated by ${run.signal}`);
  if (run.status !== 0)
    throw new Error(run.stderr || run.stdout || `jscpd exited with status ${run.status}`);
  return reportDuplicateBlocks(directory);
}

async function checkDuplicateInputs(root: string, files: string[]) {
  const config = regularInput(root, oxlintConfig)
    ? parseOxlintConfig(readFileSync(join(root, oxlintConfig), "utf8"))
    : {};
  const findings: Finding[] = [];
  const exemptions = lintPathExemptions("duplicates", config.settings, findings);
  if (findings.length) {
    printCheckFindings("duplicates", findings, performance.now());
    return 1;
  }
  const ignored = [...eslintIgnorePatterns(root).map((glob) => new Bun.Glob(glob)), ...exemptions];
  const included = files.filter((file) => !ignored.some((glob) => glob.match(file)));
  if (!included.length) {
    console.log(
      "[duplicates] no tracked production JavaScript or TypeScript files after ignores and exemptions",
    );
    return 0;
  }
  const cache = scaffoldingCache(root, [], "Duplicates");
  const directory = mkdtempSync(join(cache, "duplicates-"));
  try {
    for (const file of included) {
      const target = join(directory, "sources", file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, file), target);
    }
    return scanDuplicateBlocks(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

process.exit(
  await runTrackedLint(
    {
      step: "duplicates",
      input: productionCode,
      description: "production JavaScript or TypeScript files",
    },
    checkDuplicateInputs,
  ),
);
