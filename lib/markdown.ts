import { readFile, promises } from "node:fs";
import { main } from "markdownlint-cli2";
import config from "../config/markdownlint.json" with { type: "json" };

export async function checkMarkdown(
  root: string,
  paths: string[],
  fix = false,
  fileContents?: Record<string, string>,
): Promise<number> {
  if (!paths.length) {
    console.log("[markdown] no tracked Markdown files");
    return 0;
  }
  return main({
    directory: root,
    argv: [...(fix ? ["--fix"] : []), ...paths.map((path) => `:${path}`)],
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
    optionsDefault: { config, noInlineConfig: true, noBanner: true, noProgress: true },
    logError: console.error,
  });
}
