import {
  createOptions,
  createSession,
  type DependencyNodes,
  type MainOptions,
  type Results,
} from "knip/session";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pinsPackage } from "./gate-config.ts";
import { javaScriptOrTypeScript } from "./production-code.ts";
import {
  pathChunks,
  readPackage,
  resolveModuleIfAvailable,
  throwGitCommandFailure,
} from "./repo.ts";

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

// Use Knip 6.48's internal session for the complete entry-path set, including setup files with no exports.
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
const skillPackagePath =
  /(?<![\w.@~%/\\-])(?:node_modules\/)?((?:@[\w.~-]+\/)?[\w.~-]+)\/([^\s"'`<>()[\]{},;:!?*#|\\]+(?:<[^<>/\s]+>)?)/g;
const binaryPath = /(?<![\w.~-])node_modules\/\.bin\/([\w.@+-]+)(?=$|[\s"'`);,&|\]>])/g;
const bunBinaryCommand = /(?:^|["'`;&|])[ \t]*bun[ \t]+run[ \t]+([\w.@+-]+)(?=$|[\s"'`;&|)])/gm;
const bunBinaryArguments =
  /(?<![\w.])(?:process\.execPath|["'`]bun["'`])\s*,\s*\[\s*["'`]run["'`]\s*,\s*(?:["'`]--cwd["'`]\s*,\s*(?:[$\w.]+|["'`][^"'`\r\n]*["'`])\s*,\s*)?["'`]([\w.@+-]+)["'`]\s*(?=[,\]])/g;

function statSkillPackageTarget(path: string) {
  try {
    return statSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    return undefined;
  }
}

function installedSkillPackageExport(root: string, packageRoot: string, specifier: string) {
  if (readPackage(packageRoot).exports == null) return false;
  const exported = resolveModuleIfAvailable(specifier, root);
  return (
    exported !== undefined &&
    isAbsolute(exported) &&
    realpathSync(exported).startsWith(`${realpathSync(packageRoot)}/`)
  );
}

function skillPackageSubpathExists(root: string, name: string, reference: string) {
  const literal = reference.replace(/(?<=\/)<[^<>/\s]+>$/, "");
  const directory = literal.endsWith("/");
  const subpath = directory ? literal.slice(0, -1) : literal.replace(/\.$/, "");
  const specifier = `${name}/${subpath}`;
  if (/[<>]/.test(subpath) || /(?:^|\/)\.{0,2}(?:\/|$)/.test(specifier)) return false;
  const packageRoot = join(root, "node_modules", name);
  const target = statSkillPackageTarget(join(packageRoot, subpath));
  if (directory) return target?.isDirectory() === true;
  return (
    target?.isFile() ||
    target?.isDirectory() ||
    installedSkillPackageExport(root, packageRoot, specifier)
  );
}

function* trackedPackagePathFiles(root: string, files: string[], needles: readonly string[]) {
  for (const chunk of pathChunks(files)) {
    if (!chunk.length) continue;
    const result = spawnSync(
      "git",
      [
        "--literal-pathspecs",
        "grep",
        "--no-recurse-submodules",
        "--color=never",
        "-IlzF",
        ...needles.flatMap((needle) => ["-e", needle]),
        "--",
        ...chunk,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: Infinity },
    );
    if (result.status === 1) continue;
    if (result.status !== 0)
      throwGitCommandFailure(result, "git grep could not find package paths");
    yield* result.stdout.split("\0").filter(Boolean);
  }
}

export function unusedTextDependencyPaths(root: string, files: string[], tracked: string[]) {
  const candidates = files.filter(
    (file) =>
      !javaScriptOrTypeScript.test(file) && !/\.md$/i.test(file) && !lockfilePath.test(file),
  );
  const skillFiles = tracked.filter((file) => file.startsWith(".claude/skills/"));
  const binaryFiles = tracked.filter(
    (file) =>
      !lockfilePath.test(file) && (!/\.md$/i.test(file) || file.startsWith(".claude/skills/")),
  );
  const packages = new Map<string, Set<string>>();
  const binaries = new Map<string, Set<string>>();
  for (const [paths, needles, matchers, used] of [
    [candidates, ["node_modules/"], [nodeModulesPackagePath], packages],
    [skillFiles, ["/"], [skillPackagePath], packages],
    [
      binaryFiles,
      ["node_modules/.bin/", "bun", "process.execPath"],
      [binaryPath, bunBinaryCommand, bunBinaryArguments],
      binaries,
    ],
  ] as const) {
    for (const file of trackedPackagePathFiles(root, paths, needles)) {
      const path = join(root, file);
      const source = readFileSync(path);
      if (source.includes(0)) continue;
      const text = source.toString("utf8");
      for (const [, name, subpath] of matchers.flatMap((matcher) => [...text.matchAll(matcher)])) {
        if (subpath !== undefined && !skillPackageSubpathExists(root, name, subpath)) continue;
        const references = used.get(name) ?? new Set<string>();
        references.add(path);
        used.set(name, references);
      }
    }
  }
  return { packages, binaries };
}
