import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import template from "../template/.oxlintrc.json";
import { activeSeverity } from "./lint-rule-overlaps.ts";
import { isObject, isReason, isStrings, jsonObject, submodulePaths } from "./repo.ts";

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

function* restrictedImports(options: unknown[]) {
  for (const option of options) {
    if (typeof option === "string" || (isObject(option) && typeof option.name === "string"))
      yield { item: option, suffix: "", example: '"name": ...' };
    if (!isObject(option)) continue;
    for (const [key, example] of [
      ["paths", '"name": ...'],
      ["patterns", '"group": [...]'],
    ] as const) {
      const restrictions = option[key];
      const entries: unknown[] = Array.isArray(restrictions) ? restrictions : [];
      for (const [index, item] of entries.entries())
        yield { item, suffix: `.${key}[${index}]`, example };
    }
  }
}

export function* oxlintRestrictionFindings(config: Record<string, unknown>) {
  const overrides: unknown[] = Array.isArray(config.overrides) ? config.overrides : [];
  const blocks: [string, unknown][] = [["rules", config.rules]];
  for (const [index, override] of overrides.entries()) {
    if (isObject(override)) blocks.push([`overrides[${index}].rules`, override.rules]);
  }
  for (const [block, rules] of blocks) {
    if (!isObject(rules)) continue;
    for (const [rule, setting] of Object.entries(rules)) {
      if (!Array.isArray(setting) || !activeSeverity(setting)) continue;
      const options: unknown[] = setting.slice(1);
      const location = `${block}.${rule}`;
      switch (rule) {
        case "eslint/no-restricted-imports":
        case "typescript/no-restricted-imports":
        case "@typescript-eslint/no-restricted-imports":
        case "no-restricted-imports":
          for (const { item, suffix, example } of restrictedImports(options)) {
            if (isObject(item) && isReason(item.message)) continue;
            const pattern = isObject(item) ? (item.name ?? item.regex ?? item.group ?? item) : item;
            const guidance =
              typeof item === "string"
                ? `replace the string with { ${example}, "message": ... } and say where code that needs this import belongs`
                : "needs a message saying where code that needs this import belongs";
            yield { message: `${location}${suffix} ${guidance}`, text: JSON.stringify(pattern) };
          }
          break;
        case "eslint/no-restricted-syntax":
        case "no-restricted-syntax":
          for (const option of options) {
            if (isObject(option) && isReason(option.message)) continue;
            const selector = isObject(option) ? option.selector : option;
            if (typeof selector !== "string") continue;
            yield {
              message: `${location} needs a message saying what to write instead`,
              text: JSON.stringify(selector),
            };
          }
          break;
      }
    }
  }
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
