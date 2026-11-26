#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { renderGuides } from "../lib/guides.ts";
import { inspectImportGraph } from "../lib/import-graph.ts";
import { printCheckFindings, repoRoot } from "../lib/repo.ts";

const started = performance.now();
const { findings, hasRuntimeCycle } = await inspectImportGraph(repoRoot());
const footer = hasRuntimeCycle ? renderGuides(["import-cycle"]) : "";
printCheckFindings("cycles", findings, started);
if (footer) process.stderr.write(footer);
process.exit(findings.length ? 1 : (process.exitCode ?? 0));
