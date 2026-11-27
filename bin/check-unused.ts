#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import type { Issues, Issue } from "knip/session";
import { dirname, relative } from "node:path";
import { eslintIgnorePatterns } from "../config/eslint-ignores.js";
import { renderGuides } from "../lib/guides.ts";
import { runKnipAudit } from "../lib/knip-audit.ts";
import { javaScriptOrTypeScript } from "../lib/production-code.ts";
import { listFiles, repoRoot, withoutEnvFile } from "../lib/repo.ts";
import { regularInput, trackedInputs } from "../lib/tracked-inputs.ts";
import { gateToolDependencies } from "../lib/unused-gate-dependencies.ts";
import { nonProductionEntry, unusedBuildEntries } from "../lib/unused-entry-files.ts";
import { unusedStyleDependencies } from "../lib/unused-style-dependencies.ts";

const productionIssues = {
  files: "unused-file",
  exports: "unused-export",
  nsExports: "unused-export",
  dependencies: "unused-dependency",
} as const;
const productionKinds = Object.keys(productionIssues) as (keyof typeof productionIssues)[];

function reportUnusedIssues(root: string, issues: Issues, include: Iterable<keyof Issues>) {
  const guides = new Set<string>();
  for (const kind of include) {
    const guide =
      kind in productionIssues
        ? productionIssues[kind as keyof typeof productionIssues]
        : "unused-dependency";
    for (const records of Object.values(issues[kind])) {
      for (const { filePath, line, symbol } of Object.values(records)) {
        const location = line === undefined ? "" : `:${line}`;
        const path = relative(root, filePath);
        const name = kind === "files" ? path : symbol;
        console.error(`[unused] ${path}${location}: ${guide.replaceAll("-", " ")} ${name}`);
        guides.add(guide);
      }
    }
  }
  return guides;
}

function removeUnusedIssues(
  issues: Issues,
  kinds: (keyof Issues)[],
  remove: (issue: Issue) => boolean,
) {
  for (const kind of kinds)
    for (const records of Object.values(issues[kind]))
      for (const [key, issue] of Object.entries(records)) if (remove(issue)) delete records[key];
}

function stylesheetUses(issue: Issue, styles: Map<string, Set<string>>, workspaces: string[]) {
  const workspace = dirname(issue.filePath);
  return [...(styles.get(issue.symbol) ?? [])].some(
    (file) =>
      file.startsWith(workspace + "/") &&
      !workspaces.some(
        (nested) =>
          nested !== workspace &&
          nested.startsWith(workspace + "/") &&
          file.startsWith(nested + "/"),
      ),
  );
}

async function checkUnusedCode() {
  const root = repoRoot();
  const tracked = trackedInputs(root);
  if (
    !regularInput(root, "package.json") ||
    !tracked.some((file) => javaScriptOrTypeScript.test(file))
  ) {
    console.log("[unused] no root package.json or no tracked JavaScript or TypeScript files");
    return 0;
  }
  if (root.includes("node_modules"))
    throw new Error("Knip cannot analyze source paths containing node_modules");
  const ignores = eslintIgnorePatterns(root).map((glob) => new Bun.Glob(glob));
  const selected = (file: string) => !ignores.some((glob) => glob.match(file));
  const ignored = (issue: Issue) => !selected(relative(root, issue.filePath));
  const { results: production } = await runKnipAudit(
    root,
    productionKinds,
    unusedBuildEntries(root, listFiles(root, false).filter(selected)),
  );
  const { results: development, toolEntries } = await runKnipAudit(root, ["dependencies"]);
  removeUnusedIssues(production.issues, productionKinds, ignored);
  removeUnusedIssues(
    production.issues,
    ["files"],
    ({ filePath }) => nonProductionEntry(relative(root, filePath)) || toolEntries.has(filePath),
  );
  const styles = await unusedStyleDependencies(root, tracked.filter(selected));
  const cssUse = (issue: Issue) => stylesheetUses(issue, styles, production.includedWorkspaceDirs);
  removeUnusedIssues(production.issues, ["dependencies"], cssUse);
  const used = gateToolDependencies(root);
  removeUnusedIssues(
    development.issues,
    ["devDependencies"],
    (issue) =>
      ignored(issue) || cssUse(issue) || (issue.workspace === "." && used.has(issue.symbol)),
  );
  const guides = new Set([
    ...reportUnusedIssues(root, production.issues, productionKinds),
    ...reportUnusedIssues(root, development.issues, ["devDependencies"]),
  ]);
  process.stderr.write(renderGuides(guides));
  if (production.hasConfigLoadErrors || development.hasConfigLoadErrors) return 2;
  return Number(guides.size > 0);
}

withoutEnvFile("unused");
try {
  process.exitCode = await checkUnusedCode();
} catch (error) {
  console.error("[unused]", error);
  process.exitCode = 2;
}
