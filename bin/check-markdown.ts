#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { checkMarkdown } from "../lib/markdown.ts";
import { repoRoot, withoutEnvFile } from "../lib/repo.ts";
import { trackedInputs } from "../lib/tracked-inputs.ts";

withoutEnvFile("markdown");

try {
  const root = repoRoot();
  const code = await checkMarkdown(root, trackedInputs(root, "*.md"), process.argv[2] === "--fix");
  process.exit(code);
} catch (error) {
  console.error(`[markdown] ${(error as Error).message}`);
  process.exit(1);
}
