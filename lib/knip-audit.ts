import { createOptions, createSession, type MainOptions, type Results } from "knip/session";

type KnipRun = {
  results: Results;
  session?: {
    getEntryPaths(): Set<string>;
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

function applyUnusedKnipPolicy(options: MainOptions, entries: string[] | undefined) {
  const config = options.parsedConfig;
  config.ignoreExportsUsedInFile = true;
  for (const workspace of Object.values(config.workspaces ?? {}))
    workspace.ignoreExportsUsedInFile = true;
  if (entries?.length) {
    const rootConfig = config.workspaces?.["."] ?? config;
    const { entry } = new ConfigurationChief(options).getConfigForWorkspace(".");
    rootConfig.entry = [...entry, ...entries.map((path) => `${path}!`)];
  }
}

export async function runKnipAudit(root: string, include: string[], entries?: string[]) {
  const options = await createOptions({
    cwd: root,
    isProduction: entries !== undefined,
    isSession: true,
    isUseTscFiles: false,
    includedIssueTypes: include,
    args: { "no-progress": true },
  });
  applyUnusedKnipPolicy(options, entries);
  if (entries !== undefined)
    return { results: (await createSession(options)).getResults(), toolEntries: new Set<string>() };
  const { results, session } = await run(options);
  if (!session) throw new Error("Knip did not return an analysis session");
  const toolEntries = new Set([
    ...session.getEntryPaths(),
    ...(session.configurationFiles?.paths ?? []),
  ]);
  const reported = options.preprocessor.length
    ? (await createSession(options)).getResults()
    : results;
  return { results: reported, toolEntries };
}

export function knipStylesheetCompiler() {
  return import(new URL("../plugins/tailwind/compiler.js", knipDist).href) as Promise<{
    default(source: string): string;
  }>;
}
