declare module "markdownlint-cli2" {
  export function main(options: {
    directory: string;
    argv: string[];
    fileContents?: Record<string, string>;
    noGlobs: boolean;
    noImport: boolean;
    fs: {
      readFile: typeof import("node:fs").readFile;
      promises: {
        access: () => Promise<never>;
        readFile: typeof import("node:fs/promises").readFile;
        writeFile: typeof import("node:fs/promises").writeFile;
      };
    };
    optionsDefault: {
      config: Record<string, boolean | Record<string, unknown>>;
      noInlineConfig: boolean;
      noBanner: boolean;
      noProgress: boolean;
    };
    logError: (message: string) => void;
  }): Promise<number>;
}
