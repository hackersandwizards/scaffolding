import {
  createOptions,
  createSession,
  type DependencyNodes,
  type MainOptions,
  type Results,
} from "knip/session";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pinsPackage } from "./gate-config.ts";
import { javaScriptOrTypeScript } from "./production-code.ts";
import { pathChunks, readPackage, throwGitCommandFailure } from "./repo.ts";

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
    availableWorkspaceDirs: string[];
    getConfigForWorkspace(name: string): { entry: string[] };
    getWorkspaces(): Promise<unknown>;
  };
};

const { getDependencyUsage } = (await import(
  new URL("../graph-explorer/operations/get-dependency-usage.js", knipDist).href
)) as { getDependencyUsage(graph: KnipGraph): Map<string, DependencyNodes> };

const suppliedPlugins = {
  eslint: "eslintConfig",
  oxlint: undefined,
  prettier: "prettier",
  stryker: undefined,
  stylelint: "stylelint",
  typescript: undefined,
  vite: undefined,
  vitest: undefined,
} as const;
type SuppliedPlugin = keyof typeof suppliedPlugins;

const { Plugins } = (await import(new URL("../plugins.js", knipDist).href)) as {
  Plugins: Record<SuppliedPlugin, { config: string[] }>;
};
const { _glob: globKnipConfigs } = (await import(new URL("../util/glob.js", knipDist).href)) as {
  _glob(options: { cwd: string; patterns: string[]; gitignore: boolean }): Promise<string[]>;
};

async function enableSuppliedKnipPlugins({ cwd, parsedConfig }: MainOptions) {
  const pkg = readPackage(cwd);
  if (!pinsPackage(pkg, "@hackersandwizards/scaffolding")) return;

  const config = parsedConfig.workspaces?.["."] ?? parsedConfig;
  for (const name of Object.keys(suppliedPlugins) as SuppliedPlugin[]) {
    if (config[name] !== undefined || parsedConfig[name] !== undefined) continue;
    const key = suppliedPlugins[name];
    const patterns = Plugins[name].config.filter((pattern) => !pattern.startsWith("package."));
    const files = await globKnipConfigs({ cwd, patterns, gitignore: false });
    if (files.length || (key && pkg[key] !== undefined)) config[name] = true;
  }
}

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

async function knipPathWorkspaceDirs(options: MainOptions, results: Results) {
  if (!options.parsedConfig.ignoreWorkspaces?.length) return results.includedWorkspaceDirs;
  const chief = new ConfigurationChief({
    ...options,
    parsedConfig: { ...options.parsedConfig, ignoreWorkspaces: [] },
  });
  await chief.getWorkspaces();
  return chief.availableWorkspaceDirs;
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
      pathWorkspaceDirs: [],
    };
  await enableSuppliedKnipPlugins(options);
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
  const pathWorkspaceDirs = await knipPathWorkspaceDirs(options, results);
  return { results: reported, toolEntries, entryDependencies, pathWorkspaceDirs };
}

export function knipStylesheetCompiler() {
  return import(new URL("../plugins/tailwind/compiler.js", knipDist).href) as Promise<{
    default(source: string): string;
  }>;
}

const lockfilePath =
  /(?:\.lock(?:b|\.(?:hcl|json))?|(?:^|\/)(?:(?:npm-shrinkwrap|package-lock)\.json|pnpm-lock\.ya?ml))$/;
const nodeModulesPackagePath = /(?<![\w.~-])node_modules\/(@[\w.~-]+\/[\w.~-]+|[\w.~-]+)/g;

export function nodeModulesDependencyPaths(root: string, files: string[]) {
  const candidates = files.filter(
    (file) =>
      !javaScriptOrTypeScript.test(file) && !/\.md$/i.test(file) && !lockfilePath.test(file),
  );
  const used = new Map<string, Set<string>>();
  for (const chunk of pathChunks(candidates)) {
    if (!chunk.length) continue;
    const result = spawnSync(
      "git",
      [
        "--literal-pathspecs",
        "grep",
        "--no-recurse-submodules",
        "--color=never",
        "-IlzF",
        "-e",
        "node_modules/",
        "--",
        ...chunk,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: Infinity },
    );
    if (result.status === 1) continue;
    if (result.status !== 0)
      throwGitCommandFailure(result, "git grep could not find package paths");
    for (const file of result.stdout.split("\0").filter(Boolean)) {
      const path = join(root, file);
      const source = readFileSync(path);
      if (source.includes(0)) continue;
      for (const [, name] of source.toString("utf8").matchAll(nodeModulesPackagePath)) {
        const paths = used.get(name) ?? new Set<string>();
        paths.add(path);
        used.set(name, paths);
      }
    }
  }
  return used;
}
