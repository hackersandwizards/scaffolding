import { promises, readFile, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { main } from "markdownlint-cli2";
import config from "../config/markdownlint.json" with { type: "json" };
import { isObject, readPackage } from "./repo.ts";

const contentConfig = {
  ...config,
  MD033: false,
  MD041: false,
  MD025: false,
  MD024: false,
  MD036: false,
};

function contentFolders(root: string, markdown: unknown): string[] {
  if (markdown === undefined) return [];
  if (!isObject(markdown) || Object.keys(markdown).some((key) => key !== "content"))
    throw new Error(
      "scaffolding.markdown selects which folders use the Markdown content rules. In package.json, set it to an object with only the optional content key.",
    );
  if (markdown.content === undefined) return [];
  if (!Array.isArray(markdown.content))
    throw new Error(
      "scaffolding.markdown.content selects folders that use the Markdown content rules. In package.json, set it to an array of repository-relative folder paths.",
    );

  const realRoot = realpathSync(root);
  const entries: unknown[] = markdown.content;
  return entries.map((folder, index) => {
    const key = `scaffolding.markdown.content[${index}]`;
    if (typeof folder !== "string" || !folder.trim() || folder.includes("\0"))
      throw new Error(
        `${key} cannot select a folder without a valid path string. In package.json, set this entry to a non-empty repository-relative folder path.`,
      );
    const label = `${key} (${JSON.stringify(folder)})`;
    if (win32.isAbsolute(folder))
      throw new Error(
        `${label} is absolute, so it cannot select a repository-relative content folder. Replace this entry in package.json with a relative folder path.`,
      );

    const fromRoot = (path: string) => {
      const local = relative(realRoot, path);
      if (!local)
        throw new Error(
          `${label} selects the repository root. In package.json, set this entry to a folder below the root.`,
        );
      if (isAbsolute(local) || local.split(sep)[0] === "..")
        throw new Error(
          `${label} leaves the repository and cannot select Markdown content here. Replace this entry in package.json with a path to a folder inside the repository.`,
        );
      return local.split(sep).join("/");
    };
    const directory = resolve(realRoot, folder);
    const local = fromRoot(directory);
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(
        `${label} does not resolve to an existing directory, so it cannot select Markdown content. In package.json, set this entry to an existing folder or remove it.`,
      );
    fromRoot(realpathSync(directory));
    return local;
  });
}

export function markdownRuleGroups(paths: string[], folders: string[]) {
  const strict: string[] = [];
  const content: string[] = [];
  for (const path of paths) {
    const group = folders.some((folder) => path.startsWith(`${folder}/`)) ? content : strict;
    group.push(path);
  }
  return [
    [strict, config],
    [content, contentConfig],
  ] as const;
}

export function markdownLintRuns(groups: ReturnType<typeof markdownRuleGroups>) {
  const runs = [];
  for (const [group, rules] of groups) {
    if (!group.length) continue;
    runs.push({ rules, argv: group.map((path) => `:${path}`) });
  }
  return runs;
}

const markdownCliDefaults = {
  noGlobs: true,
  noImport: true,
  // CLI2 discovers config at each input's directory, even for explicit literal files.
  fs: {
    readFile,
    promises: {
      access: () => Promise.reject(new Error("no local config")),
      readFile: promises.readFile,
      writeFile: promises.writeFile,
    },
  },
};

const markdownRuleDefaults = { noInlineConfig: true, noBanner: true, noProgress: true };

export async function checkMarkdown(root: string, paths: string[], fix = false): Promise<number> {
  const folders = contentFolders(root, readPackage(root).scaffolding?.markdown);
  const runs = markdownLintRuns(markdownRuleGroups(paths, folders));
  if (!runs.length) {
    console.log("[markdown] no tracked Markdown files");
    return 0;
  }
  const prefix = fix ? ["--fix"] : [];
  let code = 0;
  for (const { rules, argv } of runs) {
    const result = await main({
      directory: root,
      argv: [...prefix, ...argv],
      fileContents: undefined,
      ...markdownCliDefaults,
      optionsDefault: { config: rules, ...markdownRuleDefaults },
      logError: console.error,
    });
    code = Math.max(code, result);
  }
  return code;
}

export async function checkStagedMarkdown(
  root: string,
  contents: Record<string, string>,
): Promise<number> {
  const paths = Object.keys(contents);
  const folders = contentFolders(root, readPackage(root, ":").scaffolding?.markdown);
  const runs = markdownLintRuns(markdownRuleGroups(paths, folders));
  if (!runs.length) {
    console.log("[markdown] no tracked Markdown files");
    return 0;
  }
  let code = 0;
  for (const { rules, argv } of runs) {
    const result = await main({
      directory: root,
      argv,
      fileContents: contents,
      ...markdownCliDefaults,
      optionsDefault: { config: rules, ...markdownRuleDefaults },
      logError: console.error,
    });
    code = Math.max(code, result);
  }
  return code;
}
