#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { inspectImportGraph } from "../lib/import-graph.ts";
import { finish, repoRoot } from "../lib/repo.ts";

const started = performance.now();
const { findings } = await inspectImportGraph(repoRoot());
finish("cycles", findings, started);
