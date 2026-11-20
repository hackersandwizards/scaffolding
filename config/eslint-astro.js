// Needs eslint-plugin-astro in the repository, which an Astro repository has anyway.
import { basename, dirname, join } from "node:path";
import astro from "eslint-plugin-astro";
import prettier from "eslint-config-prettier/flat";
import ts from "typescript";
import tseslint from "typescript-eslint";
import base from "./eslint.js";

const scriptParser = {
  meta: { ...tseslint.parser.meta, name: "scaffolding/astro-script-parser" },
  parseForESLint(code, options) {
    if (!options.projectService) return tseslint.parser.parseForESLint(code, options);

    try {
      // Astro hands ESLint a virtual file below the component. Give TypeScript an in-memory
      // sibling so the project's compiler options and relative imports resolve from the component.
      const astroFile = dirname(options.filePath);
      const directory = dirname(astroFile);
      const filePath = join(directory, `${basename(astroFile)}.${basename(options.filePath)}`);
      const configPath = ts.findConfigFile(directory, ts.sys.fileExists);
      const project = configPath
        ? ts.getParsedCommandLineOfConfigFile(
            configPath,
            {},
            {
              ...ts.sys,
              onUnRecoverableConfigFileDiagnostic(diagnostic) {
                throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
              },
            },
          )
        : undefined;
      const compilerOptions = project?.options ?? {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      };
      const host = ts.createCompilerHost(compilerOptions);
      const getSourceFile = host.getSourceFile;
      host.getSourceFile = (name, languageVersion, ...args) =>
        name === filePath
          ? ts.createSourceFile(name, code, languageVersion)
          : getSourceFile(name, languageVersion, ...args);
      const program = ts.createProgram({
        rootNames: [...(project?.fileNames ?? []), filePath],
        options: compilerOptions,
        projectReferences: project?.projectReferences,
        host,
      });
      return tseslint.parser.parseForESLint(code, {
        ...options,
        filePath,
        projectService: false,
        programs: [program],
      });
    } catch (error) {
      // Astro's processor drops diagnostics without a source line.
      if (error instanceof Error && !("lineNumber" in error))
        Object.assign(error, { lineNumber: 1, column: 1 });
      throw error;
    }
  },
};

export default [
  ...base,
  ...astro.configs.recommended,
  // eslint-plugin-astro loads the TypeScript parser from the working directory, which an
  // isolated install of the repository lacks: without it, TypeScript in an .astro file fails to parse.
  {
    files: ["**/*.astro"],
    processor: "astro/client-side-ts",
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
  {
    files: ["**/*.astro/*.ts"],
    languageOptions: { parser: scriptParser },
  },
  prettier,
];
