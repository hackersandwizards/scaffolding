#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import type { Issues, Issue, Results } from "knip/session";
import { dirname, relative } from "node:path";
import { eslintIgnorePatterns, eslintToolIgnorePatterns } from "../config/eslint-ignores.js";
import { renderGuides } from "../lib/guides.ts";
import { runKnipAudit, unusedTextDependencyPaths } from "../lib/knip-audit.ts";
import { javaScriptOrTypeScript } from "../lib/production-code.ts";
import { listFiles, repoRoot, withoutEnvFile } from "../lib/repo.ts";
import { regularInput, trackedInputs } from "../lib/tracked-inputs.ts";
import { declaredBinaries, gateToolDependencies } from "../lib/unused-gate-dependencies.ts";
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

function workspaceUsesDependency(
  issue: Issue,
  uses: Set<string> | undefined,
  workspaces: string[],
) {
  const workspace = dirname(issue.filePath);
  return [...(uses ?? [])].some(
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

function unusedAuditEntries(root: string, selected: (path: string) => boolean) {
  const files = listFiles(root, false);
  const toolPaths = eslintToolIgnorePatterns.map((glob) => new Bun.Glob(glob));
  const tools = files.filter(
    (path) =>
      javaScriptOrTypeScript.test(path) &&
      toolPaths.some((glob) => glob.match(path)) &&
      regularInput(root, path),
  );
  return [...tools, ...unusedBuildEntries(root, files.filter(selected))];
}

function reportUnusedAudit(root: string, production: Results, development: Results) {
  const guides = new Set([
    ...reportUnusedIssues(root, production.issues, productionKinds),
    ...reportUnusedIssues(root, development.issues, ["devDependencies"]),
  ]);
  process.stderr.write(renderGuides(guides));
  if (production.hasConfigLoadErrors || development.hasConfigLoadErrors) return 2;
  return Number(guides.size > 0);
}

async function removeUsedDependencyFindings(
  root: string,
  files: string[],
  {
    production,
    development,
    ignored,
    tracked,
  }: {
    production: Results;
    development: Awaited<ReturnType<typeof runKnipAudit>>;
    ignored: (issue: Issue) => boolean;
    tracked: string[];
  },
) {
  const styles = await unusedStyleDependencies(root, files);
  const { packages, binaries } = unusedTextDependencyPaths(root, files, tracked);
  const pathWorkspaces = development.pathWorkspaceDirs;
  const usedByPath = (issue: Issue) =>
    workspaceUsesDependency(issue, packages.get(issue.symbol), pathWorkspaces) ||
    (binaries.size > 0 &&
      declaredBinaries(root, issue.symbol, dirname(issue.filePath)).some((binary) =>
        workspaceUsesDependency(issue, binaries.get(binary), pathWorkspaces),
      ));
  const imported = (issue: Issue) =>
    [styles, development.entryDependencies].some((uses) =>
      workspaceUsesDependency(issue, uses.get(issue.symbol), production.includedWorkspaceDirs),
    ) || usedByPath(issue);
  const used = gateToolDependencies(root);
  const gateTool = (issue: Issue) => issue.workspace === "." && used.has(issue.symbol);
  removeUnusedIssues(
    production.issues,
    ["dependencies"],
    (issue) => imported(issue) || gateTool(issue),
  );
  removeUnusedIssues(
    development.results.issues,
    ["devDependencies"],
    (issue) => ignored(issue) || imported(issue) || gateTool(issue),
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
  const entries = unusedAuditEntries(root, selected);
  const { results: production } = await runKnipAudit(root, productionKinds, {
    production: true,
    entries,
  });
  const development = await runKnipAudit(root, ["dependencies"], { production: false, entries });
  removeUnusedIssues(production.issues, productionKinds, ignored);
  removeUnusedIssues(
    production.issues,
    ["files"],
    ({ filePath }) =>
      nonProductionEntry(relative(root, filePath)) || development.toolEntries.has(filePath),
  );
  await removeUsedDependencyFindings(root, tracked.filter(selected), {
    production,
    development,
    ignored,
    tracked,
  });
  return reportUnusedAudit(root, production, development.results);
}

withoutEnvFile("unused");
try {
  process.exitCode = await checkUnusedCode();
} catch (error) {
  console.error("[unused]", error);
  process.exitCode = 2;
}
