#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { renderGuides } from "../lib/guides.ts";
import { inspectImportGraph } from "../lib/import-graph.ts";
import { finish, repoRoot } from "../lib/repo.ts";

const started = performance.now();
const { findings, hasRuntimeCycle } = await inspectImportGraph(repoRoot());
finish("cycles", findings, started, hasRuntimeCycle ? renderGuides(["import-cycle"]) : "");
