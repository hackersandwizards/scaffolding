#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderGuides } from "../lib/guides.ts";
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
      if (stat && !stat.isDirectory())
        throw new Error(
          `${directory} blocks the layer map path ${layerMapPath}. Move the entry aside and make ${directory} a regular directory.`,
        );
    }
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (generated === undefined) {
      if (stat) throw new Error(`no layers declared: delete ${layerMapPath}`);
    } else if (mode === "--write") {
      if (stat && !stat.isFile())
        throw new Error(
          `The generator can only overwrite a regular file at ${layerMapPath}. Move the entry aside and run \`bun run scaffolding layers --write\` to generate the map.`,
        );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, generated);
    } else if (!stat?.isFile() || readFileSync(path, "utf8") !== generated) {
      console.error(
        `[layers] ${layerMapPath} is stale: run \`bun run scaffolding layers --write\` and commit the file with this change.`,
      );
      process.stderr.write(renderGuides(["layers"]));
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`[layers] ${(error as Error).message}`);
  process.exitCode = 1;
}
