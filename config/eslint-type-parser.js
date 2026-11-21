import ts from "typescript";
import tseslint from "typescript-eslint";
import { readTypeScriptProject } from "./typescript.js";

const parser = tseslint.parser;

export default {
  meta: { ...parser.meta, name: "scaffolding/type-parser" },
  parseForESLint(code, options) {
    try {
      return parser.parseForESLint(code, { ...options, projectService: true });
    } catch (error) {
      // The full gate also lints scripts and tests outside a project's include list.
      if (
        !(error instanceof Error) ||
        !error.message.includes("was not found by the project service")
      )
        throw error;
      const file = options.filePath;
      const config = ts.findConfigFile(file, ts.sys.fileExists);
      const compilerOptions = {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        ...(config ? readTypeScriptProject(config).options : {}),
        allowJs: true,
        noEmit: true,
      };
      const host = ts.createCompilerHost(compilerOptions);
      const getSourceFile = host.getSourceFile;
      host.getSourceFile = (name, version, ...args) =>
        name === file
          ? ts.createSourceFile(name, code, version)
          : getSourceFile(name, version, ...args);
      return parser.parseForESLint(code, {
        ...options,
        projectService: false,
        programs: [ts.createProgram([file], compilerOptions, host)],
      });
    }
  },
};
