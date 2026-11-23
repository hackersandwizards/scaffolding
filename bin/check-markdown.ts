#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { checkMarkdown } from "../lib/markdown.ts";
import { reader, repoRoot, withoutEnvFile } from "../lib/repo.ts";
import { stagedDiff, stagedPaths } from "../lib/staged-paths.ts";
import { inNodeModules, trackedInputs } from "../lib/tracked-inputs.ts";

withoutEnvFile("markdown");

try {
  const root = repoRoot();
  const mode = process.argv[2];
  const staged = mode === "--staged";
  const paths = staged
    ? stagedPaths(stagedDiff(root)).regularPaths.filter(
        (path) => path.endsWith(".md") && !inNodeModules(path),
      )
    : trackedInputs(root, "*.md");
  if (staged && !paths.length) process.exit(0);
  const read = reader(root, true);
  const contents = staged
    ? Object.fromEntries(paths.map((path) => [path, read(path).toString()]))
    : undefined;
  const code = await checkMarkdown(root, paths, mode === "--fix", contents);
  process.exit(code);
} catch (error) {
  console.error(`[markdown] ${(error as Error).message}`);
  process.exit(1);
}
