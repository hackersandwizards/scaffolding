import { dirname } from "node:path";
import ts from "typescript";
import tseslint from "typescript-eslint";
import { submodulePaths } from "./submodules.js";
import { readTypeScriptProject } from "./typescript.js";

const parser = tseslint.parser;
const fallbackProjects = new Map();

function fallbackProject(file, root) {
  const config = ts.findConfigFile(dirname(file), ts.sys.fileExists);
  const id = config ?? root;
  let project = fallbackProjects.get(id);
  if (!project) {
    const parsed = config ? readTypeScriptProject(config) : undefined;
    const options = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      ...parsed?.options,
      allowJs: true,
      noEmit: true,
    };
    const folder = config ? dirname(config) : root;
    const included = new Set(parsed?.fileNames ?? []);
    const excluded = ts.sys
      .readDirectory(
        folder,
        [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
        [
          "**/node_modules",
          "**/.git",
          "**/dist",
          "**/coverage",
          "**/.astro",
          "**/.claude/worktrees",
          ...submodulePaths(folder),
        ],
      )
      .filter((name) => !included.has(name));
    const roots = new Set([
      ...excluded,
      ...[...included].filter((name) => /\.d\.[cm]?ts$/.test(name)),
    ]);
    project = { options, roots, references: parsed?.projectReferences, program: undefined };
    fallbackProjects.set(id, project);
  }
  return project;
}

function fallbackProgram(file, code, root) {
  const project = fallbackProject(file, root);
  const { options, roots, references } = project;
  const saved = ts.sys.readFile(file);
  if (saved === code && project.program?.getSourceFile(file)?.text === code) return project.program;
  const host = ts.createCompilerHost(options);
  const { getSourceFile } = host;
  if (saved !== code) {
    host.getSourceFile = (name, version, ...args) =>
      name === file
        ? ts.createSourceFile(name, code, version)
        : getSourceFile(name, version, ...args);
  } else {
    roots.add(file);
  }
  const program = ts.createProgram({
    rootNames: roots.has(file) ? [...roots] : [...roots, file],
    options,
    projectReferences: references,
    host,
    oldProgram: project.program,
  });
  if (saved === code) project.program = program;
  return program;
}

export default {
  meta: { ...parser.meta, name: "scaffolding/type-parser" },
  parseForESLint(code, options) {
    try {
      return parser.parseForESLint(code, { ...options, projectService: true });
    } catch (error) {
      // The project service has no error code for a file outside its configured projects.
      if (
        !(error instanceof Error) ||
        !error.message.includes("was not found by the project service")
      )
        throw error;
      return parser.parseForESLint(code, {
        ...options,
        projectService: false,
        programs: [
          fallbackProgram(options.filePath, code, options.tsconfigRootDir ?? process.cwd()),
        ],
      });
    }
  },
};
