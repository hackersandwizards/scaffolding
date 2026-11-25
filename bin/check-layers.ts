#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { layerMapPath, renderLayers } from "../lib/layers.ts";
import { repoRoot } from "../lib/repo.ts";

const root = repoRoot();
const mode = process.argv[2];
const path = join(root, layerMapPath);
try {
  const generated = await renderLayers(root);
  if (mode === undefined) {
    if (generated !== undefined) process.stdout.write(generated);
  } else {
    for (const directory of ["docs", "docs/architecture"]) {
      const stat = lstatSync(join(root, directory), { throwIfNoEntry: false });
      if (stat && !stat.isDirectory()) throw new Error(`${directory} must be a regular directory`);
    }
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (generated === undefined) {
      if (stat) throw new Error(`no layers declared: delete ${layerMapPath}`);
    } else if (mode === "--write") {
      if (stat && !stat.isFile()) throw new Error(`${layerMapPath} must be a regular file`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, generated);
    } else if (!stat?.isFile() || readFileSync(path, "utf8") !== generated) {
      throw new Error(
        `${layerMapPath} is stale: run \`bun run scaffolding layers --write\` and commit the file with this change.`,
      );
    }
  }
} catch (error) {
  console.error(`[check:layers] ${(error as Error).message}`);
  process.exitCode = 1;
}
