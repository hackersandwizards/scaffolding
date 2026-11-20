import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import template from "../template/.oxlintrc.json";
import { isObject, isStrings, jsonObject, submodulePaths } from "./repo.ts";

export const oxlintConfig = ".oxlintrc.json";
export const oxlintSource = /\.(?:[cm]?[jt]s|[jt]sx|astro)$/;

export function oxlintExtends(root: string) {
  const own = fileURLToPath(new URL("..", import.meta.url));
  return resolve(root) === resolve(own) ? "./config/oxlint.json" : template.extends[0];
}

export function oxlintConfiguration(root: string) {
  const file = join(root, oxlintConfig);
  if (!lstatSync(file).isFile()) throw new Error("must be a regular file");
  const config = jsonObject(readFileSync(file));
  if (!isObject(config.options) || config.options.typeAware !== true)
    throw new Error("options.typeAware must be true");
  const ignores = config.ignorePatterns;
  if (!isStrings(ignores) || template.ignorePatterns.some((pattern) => !ignores.includes(pattern)))
    throw new Error("ignorePatterns must include the shared patterns");
  if (!isStrings(config.plugins) || !config.plugins.includes("typescript"))
    throw new Error('plugins must include "typescript"');
  const env = config.env;
  if (!isObject(env) || Object.keys(template.env).some((name) => env[name] !== true))
    throw new Error("env must include the shared browser, Node and Bun globals");
  const expected = oxlintExtends(root);
  if (!isStrings(config.extends) || config.extends.length !== 1 || config.extends[0] !== expected)
    throw new Error(`extends must list "${expected}"`);
  return config;
}

export function runOxlint(root: string, args: string[], capture = false) {
  const manifest = fileURLToPath(import.meta.resolve("oxlint/package.json"));
  const cli = join(dirname(manifest), "bin/oxlint");
  return spawnSync(
    process.execPath,
    ["--no-env-file", "--bun", cli, "--disable-nested-config", "-c", oxlintConfig, ...args],
    {
      cwd: root,
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      maxBuffer: Infinity,
    },
  );
}

export function oxlintOutput(root: string, args: string[]) {
  const result = runOxlint(root, args, true);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error));
  return result.stdout;
}

export function oxlintTargets(root: string) {
  const ignored = submodulePaths(root).flatMap((path) => ["--ignore-pattern", `/${path}/**`]);
  return [...ignored, "--no-error-on-unmatched-pattern", "."];
}

export function oxlintFiles(root: string, args = oxlintTargets(root)) {
  const files = oxlintOutput(root, ["--debug=files", ...args])
    .split("\n")
    .filter(Boolean);
  if (files.some((file) => !existsSync(join(root, file)) || !statSync(join(root, file)).isFile()))
    throw new Error("could not read the files selected by oxlint");
  return files;
}

async function requireTypeScriptProjects(root: string, files: string[]) {
  const sources = files.filter((file) => /\.(?:[cm]?ts|tsx)$/.test(file));
  if (!sources.length) return;
  const [{ default: ts }, { readTypeScriptProject }] = await Promise.all([
    import("typescript"),
    import("../config/typescript.js"),
  ]);
  const projects = new Map<
    string,
    {
      paths: Set<string>;
      parsed: ReturnType<typeof readTypeScriptProject>;
      program?: import("typescript").Program;
    }
  >();
  const failures: string[] = [];
  for (const file of sources) {
    const absolute = resolve(root, file);
    const config = ts.findConfigFile(dirname(absolute), ts.sys.fileExists);
    if (!config || !resolve(config).startsWith(root + "/")) {
      failures.push(`${file}: no tsconfig.json in the repository`);
      continue;
    }
    let project = projects.get(config);
    if (!project) {
      const parsed = readTypeScriptProject(config);
      project = { paths: new Set(parsed.fileNames), parsed };
      projects.set(config, project);
    }
    if (!project.paths.has(absolute)) {
      const { fileNames: rootNames, options, projectReferences } = project.parsed;
      project.program ??= ts.createProgram({ rootNames, options, projectReferences });
      if (!project.program.getSourceFile(absolute))
        failures.push(`${file}: is outside ${config.slice(root.length + 1)}`);
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) {
  const root = process.cwd();
  try {
    oxlintConfiguration(root);
    const args = oxlintTargets(root);
    await requireTypeScriptProjects(root, oxlintFiles(root, args));
    process.exitCode = runOxlint(root, [...process.argv.slice(2), ...args]).status ?? 1;
  } catch (error) {
    console.error(`[oxlint] ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
