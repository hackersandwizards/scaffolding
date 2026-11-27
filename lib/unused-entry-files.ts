import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  catalogHead,
  catalogHome,
  catalogPagesDir,
  catalogStoryGlob,
  storiesDir,
} from "./catalog-paths.ts";
import { TEST } from "./repo.ts";
import { regularInput } from "./tracked-inputs.ts";

const catalogSpecifier = "@hackersandwizards/scaffolding/catalog";
const buildConfig = /^(?:astro|vite)\.config\.[cm]?[jt]s$/;
const toolConfig = /^(?:vitest|stryker|stylelint|playwright)(?:\.[\w-]+)*\.config\.[cm]?[jt]s$/;
const catalogEntries = [
  catalogStoryGlob(storiesDir(".")),
  `${catalogPagesDir("catalog")}/**/*`,
  join("catalog", catalogHead),
  join("catalog", catalogHome),
].map((glob) => new Bun.Glob(glob));

export const nonProductionEntry = (path: string) =>
  TEST.test(path) || /\.stories\.|\.d\.[cm]?ts$/.test(path) || toolConfig.test(basename(path));

export function unusedBuildEntries(root: string, files: string[]) {
  const build = files.filter(
    (path) => buildConfig.test(basename(path)) && regularInput(root, path),
  );
  const scan = new Bun.Transpiler({ loader: "ts" });
  const usesCatalog = build.some((path) =>
    scan
      .scanImports(readFileSync(join(root, path), "utf8"))
      .some(({ path }) => path === catalogSpecifier),
  );
  if (!usesCatalog) return build;
  return [...build, ...files.filter((path) => catalogEntries.some((glob) => glob.match(path)))];
}
