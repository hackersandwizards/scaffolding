import { readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import ts from "typescript";
import tseslint from "typescript-eslint";
import { submodulePaths } from "./submodules.js";
import { readTypeScriptProject } from "./typescript.js";

export function astroClientScript(node) {
  return (
    node.type === "JSXElement" &&
    node.openingElement.name.name === "script" &&
    node.children.length > 0 &&
    !node.openingElement.selfClosing &&
    !node.openingElement.attributes.some(
      (attr) =>
        attr.name?.name === "type" &&
        attr.value?.type === "Literal" &&
        /json$|importmap/i.test(String(attr.value.value)),
    )
  );
}

export function astroTypePrograms(processor, astroParser) {
  const active = new Map();
  const projects = new Map();
  const untyped = Boolean(process.env.SCAFFOLDING_LINT_UNTYPED);
  const virtual = (file, index) => `${file}.${index}.ts`;
  function extractScripts(code, file) {
    const extracted = processor.preprocess(code, file);
    const bindings = new Map();
    const unusedBindings = new Map();
    if (code.includes("define:vars") && extracted.length > 1) {
      const template = astroParser.parseTemplate(code);
      const frontmatter = template.result.ast.frontmatter?.program;
      const content = frontmatter ? code.slice(frontmatter.start, frontmatter.end) : "";
      let index = 0;
      template.walk(template.result.ast, (node) => {
        if (!astroClientScript(node)) return;
        const block = extracted[++index];
        const expression = node.openingElement.attributes.find(
          (attr) => attr.name?.name === "define:vars",
        )?.value;
        const variables = expression?.expression;
        if (variables?.type !== "ObjectExpression") return;
        const name = `${virtual(file, index)}.vars.ts`;
        const specifier = JSON.stringify(`./${basename(name)}`);
        bindings.set(
          name,
          `${content}\nexport default (${code.slice(variables.start, variables.end)});\n`,
        );
        const original = new Map();
        block.text = block.text.replace(
          /^\/\* global\n([\s\S]+?)\n-- define:vars \*\//,
          (comment, names) => {
            for (const [offset, key] of names.split("\n").entries()) original.set(key, offset + 2);
            return comment.replace(/[^\r\n]/g, " ");
          },
        );
        // Keep the processor's source offsets. Astro drops messages in these appended declarations.
        const declarations = new Map();
        const names = new Set();
        for (const property of variables.properties) {
          if (property.type !== "Property" || property.computed) continue;
          const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
          if (typeof key !== "string") continue;
          if (!ts.isIdentifierText(key, ts.ScriptTarget.ESNext) || names.has(key)) continue;
          names.add(key);
          if (original.has(key))
            declarations.set(block.text.split("\n").length + 1, original.get(key));
          block.text += `\ndeclare const ${key}: (typeof import(${specifier}))["default"][${JSON.stringify(key)}];\n`;
        }
        unusedBindings.set(index, declarations);
      });
    }
    return {
      extracted,
      unusedBindings,
      sources: new Map([
        ...extracted.slice(1).map(({ text }, index) => [virtual(file, index + 1), text]),
        ...bindings,
      ]),
    };
  }

  function discoverProject(file, root) {
    const config = ts.findConfigFile(dirname(file), ts.sys.fileExists);
    return config && !relative(root, config).startsWith("..") ? config : undefined;
  }

  function scriptProject(file, root) {
    const config = discoverProject(file, root);
    const key = config ?? root;
    let project = projects.get(key);
    if (!project) {
      const parsed = config ? readTypeScriptProject(config) : undefined;
      const options = {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        ...parsed?.options,
        moduleDetection: ts.ModuleDetectionKind.Force,
      };
      if (options.lib)
        options.lib = [...new Set([...options.lib, "lib.dom.d.ts", "lib.dom.iterable.d.ts"])];
      const scripts = new Map();
      const folder = config ? dirname(config) : root;
      const ignored = [
        "**/node_modules",
        "**/.git",
        "**/dist",
        "**/.astro",
        ...submodulePaths(root).map((path) => join(root, path)),
      ];
      for (const component of new Set([
        file,
        ...ts.sys.readDirectory(folder, [".astro"], ignored),
      ])) {
        if (discoverProject(component, root) !== config) continue;
        let entry = active.get(component);
        if (!entry) {
          entry = extractScripts(readFileSync(component, "utf8").replace(/^\uFEFF/, ""), component);
          processor.postprocess(
            entry.extracted.map(() => []),
            component,
          );
        }
        for (const [name, text] of entry.sources) scripts.set(name, text);
      }
      project = { parsed, options, scripts, program: undefined };
      projects.set(key, project);
    }
    return project;
  }

  const parser = {
    meta: { ...tseslint.parser.meta, name: "scaffolding/astro-script-parser" },
    parseForESLint(code, options) {
      if (untyped)
        return tseslint.parser.parseForESLint(code, {
          lib: ["esnext", "dom", "dom.iterable"],
          ...options,
        });
      try {
        const component = dirname(options.filePath);
        // ESLint prefixes an extracted block's filename with its position in preprocess's array.
        const index = Number(basename(options.filePath).split("_", 1)[0]);
        const file = virtual(component, index);
        const project = scriptProject(component, options.tsconfigRootDir ?? process.cwd());
        const { parsed, scripts } = project;
        if (scripts.get(file) !== code) {
          for (const [name, text] of active.get(component)?.sources ?? []) scripts.set(name, text);
          scripts.set(file, code);
          project.program = undefined;
        }
        if (!project.program) {
          const host = ts.createCompilerHost(project.options);
          const { getSourceFile, fileExists, readFile } = host;
          host.fileExists = (name) => scripts.has(name) || fileExists(name);
          host.readFile = (name) => scripts.get(name) ?? readFile(name);
          host.getSourceFile = (name, version, ...args) =>
            scripts.has(name)
              ? ts.createSourceFile(name, scripts.get(name), version)
              : getSourceFile(name, version, ...args);
          project.program = ts.createProgram({
            rootNames: [...(parsed?.fileNames ?? []), ...scripts.keys()],
            options: project.options,
            projectReferences: parsed?.projectReferences,
            host,
          });
        }
        return tseslint.parser.parseForESLint(code, {
          ...options,
          filePath: file,
          projectService: false,
          programs: [project.program],
        });
      } catch (error) {
        if (error instanceof Error && !("lineNumber" in error))
          Object.assign(error, { lineNumber: 1, column: 1 });
        throw error;
      }
    },
  };
  return {
    parser,
    preprocess(code, filename) {
      const entry = extractScripts(code, filename);
      active.set(filename, entry);
      return entry.extracted;
    },
    postprocess(messages, filename) {
      const entry = active.get(filename);
      active.delete(filename);
      for (const [index, declarations] of entry?.unusedBindings ?? []) {
        for (const message of messages[index] ?? []) {
          const line = declarations.get(message.line);
          if (line && message.ruleId === "@typescript-eslint/no-unused-vars")
            Object.assign(message, { line, column: 1, endLine: line, endColumn: 1 });
        }
      }
      return processor.postprocess(messages, filename);
    },
  };
}
