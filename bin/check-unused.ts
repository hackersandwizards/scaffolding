#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { createOptions, createSession, type Issues } from "knip/session";
import { relative } from "node:path";
import { renderGuides } from "../lib/guides.ts";
import { javaScriptOrTypeScript } from "../lib/production-code.ts";
import { repoRoot, withoutEnvFile } from "../lib/repo.ts";
import { regularInput, trackedInputs } from "../lib/tracked-inputs.ts";
import { gateToolDependencies } from "../lib/unused-gate-dependencies.ts";

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

async function collectKnipIssues(root: string, production: boolean) {
  const options = await createOptions({
    cwd: root,
    isProduction: production,
    isSession: true,
    isUseTscFiles: false,
    includedIssueTypes: production ? productionKinds : ["dependencies"],
    args: { "no-progress": true },
  });
  options.parsedConfig.ignoreExportsUsedInFile = true;
  for (const workspace of Object.values(options.parsedConfig.workspaces ?? {}))
    workspace.ignoreExportsUsedInFile = true;
  return (await createSession(options)).getResults();
}

async function checkUnusedCode() {
  const root = repoRoot();
  if (
    !regularInput(root, "package.json") ||
    !trackedInputs(root).some((file) => javaScriptOrTypeScript.test(file))
  ) {
    console.log("[unused] no root package.json or no tracked JavaScript or TypeScript files");
    return 0;
  }
  if (root.includes("node_modules"))
    throw new Error("Knip cannot analyze source paths containing node_modules");
  const production = await collectKnipIssues(root, true);
  const development = await collectKnipIssues(root, false);
  const used = gateToolDependencies(root);
  const rootDev = Object.values(development.issues.devDependencies);
  for (const records of rootDev)
    for (const [key, issue] of Object.entries(records))
      if (issue.workspace === "." && used.has(issue.symbol)) delete records[key];
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
