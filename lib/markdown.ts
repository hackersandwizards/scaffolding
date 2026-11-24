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
    throw new Error("scaffolding.markdown must be an object with only the optional content key");
  if (markdown.content === undefined) return [];
  if (!Array.isArray(markdown.content))
    throw new Error(
      "scaffolding.markdown.content must be an array of repository-relative folder paths",
    );

  const realRoot = realpathSync(root);
  const entries: unknown[] = markdown.content;
  return entries.map((folder, index) => {
    const key = `scaffolding.markdown.content[${index}]`;
    if (typeof folder !== "string" || !folder.trim() || folder.includes("\0"))
      throw new Error(`${key} must be a folder path string`);
    const label = `${key} (${JSON.stringify(folder)})`;
    if (win32.isAbsolute(folder)) throw new Error(`${label} must be repository-relative`);

    const fromRoot = (path: string) => {
      const local = relative(realRoot, path);
      if (!local) throw new Error(`${label} must name a folder below the repository root`);
      if (isAbsolute(local) || local.split(sep)[0] === "..")
        throw new Error(`${label} leaves the repository`);
      return local.split(sep).join("/");
    };
    const directory = resolve(realRoot, folder);
    const local = fromRoot(directory);
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`${label} must name an existing folder`);
    fromRoot(realpathSync(directory));
    return local;
  });
}

export async function checkMarkdown(
  root: string,
  paths: string[],
  fix = false,
  fileContents?: Record<string, string>,
): Promise<number> {
  const folders = contentFolders(
    root,
    readPackage(root, fileContents ? ":" : undefined).scaffolding?.markdown,
  );
  if (!paths.length) {
    console.log("[markdown] no tracked Markdown files");
    return 0;
  }
  const strict: string[] = [];
  const content: string[] = [];
  for (const path of paths) {
    const group = folders.some((folder) => path.startsWith(`${folder}/`)) ? content : strict;
    group.push(path);
  }
  let code = 0;
  for (const [group, rules] of [
    [strict, config],
    [content, contentConfig],
  ] as const) {
    if (!group.length) continue;
    const result = await main({
      directory: root,
      argv: [...(fix ? ["--fix"] : []), ...group.map((path) => `:${path}`)],
      fileContents,
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
      optionsDefault: { config: rules, noInlineConfig: true, noBanner: true, noProgress: true },
      logError: console.error,
    });
    code = Math.max(code, result);
  }
  return code;
}
