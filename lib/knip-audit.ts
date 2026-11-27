import {
  createOptions,
  createSession,
  type DependencyNodes,
  type MainOptions,
  type Results,
} from "knip/session";
import { resolve } from "node:path";

type KnipGraph = Map<
  string,
  {
    imports: {
      internal: ReadonlyMap<string, unknown>;
      external: ReadonlySet<{ specifier: string }>;
    };
  }
>;

type KnipAuditRoots = { production: boolean; entries: string[] };

type KnipRun = {
  results: Results;
  session?: {
    getEntryPaths(): Set<string>;
    getGraph(): KnipGraph;
    configurationFiles?: { paths: Set<string> };
  };
};

// Knip 6.48's public session descriptor omits entry files with no exports, including setup files.
const knipDist = import.meta.resolve("knip/session");
const { run } = (await import(new URL("../run.js", knipDist).href)) as {
  run(options: MainOptions): Promise<KnipRun>;
};
const { ConfigurationChief } = (await import(
  new URL("../ConfigurationChief.js", knipDist).href
)) as {
  ConfigurationChief: new (options: MainOptions) => {
    getConfigForWorkspace(name: string): { entry: string[] };
  };
};

const { getDependencyUsage } = (await import(
  new URL("../graph-explorer/operations/get-dependency-usage.js", knipDist).href
)) as { getDependencyUsage(graph: KnipGraph): Map<string, DependencyNodes> };

function knipEntryDependencies(graph: KnipGraph, entryPaths: string[]) {
  const reached: KnipGraph = new Map();
  const pending = new Set(entryPaths);
  for (const path of pending) {
    const file = graph.get(path);
    if (!file) continue;
    const { internal, external } = file.imports;
    reached.set(path, { imports: { internal, external } });
    for (const imported of internal.keys()) pending.add(imported);
  }
  return new Map(
    [...getDependencyUsage(reached)].map(([name, { imports }]) => [
      name,
      new Set(imports.map(({ filePath }) => filePath)),
    ]),
  );
}

function applyUnusedKnipPolicy(options: MainOptions, entries: string[]) {
  const config = options.parsedConfig;
  config.ignoreExportsUsedInFile = true;
  for (const workspace of Object.values(config.workspaces ?? {}))
    workspace.ignoreExportsUsedInFile = true;
  if (entries.length) {
    const rootConfig = config.workspaces?.["."] ?? config;
    const { entry } = new ConfigurationChief(options).getConfigForWorkspace(".");
    rootConfig.entry = [...new Set([...entry, ...entries.map((path) => `${path}!`)])];
  }
}

export async function runKnipAudit(
  root: string,
  include: string[],
  { production, entries }: KnipAuditRoots,
) {
  const options = await createOptions({
    cwd: root,
    isProduction: production,
    isSession: true,
    isUseTscFiles: false,
    includedIssueTypes: include,
    args: { "no-progress": true },
  });
  applyUnusedKnipPolicy(options, entries);
  if (production)
    return {
      results: (await createSession(options)).getResults(),
      toolEntries: new Set<string>(),
      entryDependencies: new Map<string, Set<string>>(),
    };
  const { results, session } = await run(options);
  if (!session) throw new Error("Knip did not return an analysis session");
  const toolEntries = new Set([
    ...session.getEntryPaths(),
    ...(session.configurationFiles?.paths ?? []),
  ]);
  const reported = options.preprocessor.length
    ? (await createSession(options)).getResults()
    : results;
  // Some plugins classify build configs as development entries even when given a production
  // entry pattern. Count imports only from the explicit roots and their resolved local imports.
  const entryDependencies = knipEntryDependencies(
    session.getGraph(),
    entries.map((path) => resolve(root, path)),
  );
  return { results: reported, toolEntries, entryDependencies };
}

export function knipStylesheetCompiler() {
  return import(new URL("../plugins/tailwind/compiler.js", knipDist).href) as Promise<{
    default(source: string): string;
  }>;
}
