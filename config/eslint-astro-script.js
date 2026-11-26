import { readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import ts from "typescript";
import tseslint from "typescript-eslint";
import {
  astroFrontmatter,
  frontmatterBlock,
  frontmatterMessages,
} from "./eslint-astro-frontmatter.js";
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

const astroScriptModulePath = (file, index) => `${file}.${index}.ts`;

export function declareAstroVariables(block, variables, specifier) {
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
    if (original.has(key)) declarations.set(block.text.split("\n").length + 1, original.get(key));
    const type = `(typeof import(${specifier}))["default"][${JSON.stringify(key)}]`;
    block.text += `\n/** @type {${type}} */ let ${key};\n`;
  }
  return declarations;
}

export function findAstroTypeScriptProject(file, root) {
  const config = ts.findConfigFile(dirname(file), ts.sys.fileExists);
  return config && !relative(root, config).startsWith("..") ? config : undefined;
}

export function astroCompilerOptions(config) {
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
  return { parsed, options };
}

export function compileAstroProject(project, frontmatter) {
  const { parsed, scripts } = project;
  const compilerOptions = {
    jsx: ts.JsxEmit.Preserve,
    ...project.options,
    allowNonTsExtensions: true,
  };
  const host = ts.createCompilerHost(compilerOptions);
  const { getSourceFile, fileExists, readFile } = host;
  host.fileExists = (name) => scripts.has(name) || fileExists(name);
  host.readFile = (name) => scripts.get(name)?.text ?? readFile(name);
  host.getSourceFile = (name, version, ...args) => {
    const source = scripts.get(name);
    // Keep ESLint's virtual .ts paths so consumer overrides still match inline scripts.
    return source
      ? ts.createSourceFile(name, source.text, version, false, source.kind)
      : getSourceFile(name, version, ...args);
  };
  const astroTypes = frontmatter.host(host, compilerOptions, project.folder);
  const rootNames = [...(parsed?.fileNames ?? []), ...scripts.keys(), ...astroTypes];
  return ts.createProgram({
    rootNames,
    options: compilerOptions,
    projectReferences: parsed?.projectReferences,
    host,
  });
}

export function remapAstroVariableMessages(messages, unusedBindings) {
  for (const [index, declarations] of unusedBindings) {
    for (const message of messages[index] ?? []) {
      const line = declarations.get(message.line);
      if (line && message.ruleId === "@typescript-eslint/no-unused-vars")
        Object.assign(message, { line, column: 1, endLine: line, endColumn: 1 });
    }
  }
}

export function astroBlockFile(filePath) {
  const component = dirname(filePath);
  // ESLint prefixes an extracted block's filename with its position in preprocess's array.
  const [index, block] = basename(filePath).split("_", 2);
  const isFrontmatter = block === frontmatterBlock;
  const file = isFrontmatter ? component : astroScriptModulePath(component, Number(index));
  return { component, file, isFrontmatter };
}

export class AstroScriptPrograms {
  active = new Map();
  projects = new Map();
  untyped = Boolean(process.env.SCAFFOLDING_LINT_UNTYPED);
  frontmatter = astroFrontmatter();

  constructor(processor, astroParser) {
    this.processor = processor;
    this.astroParser = astroParser;
  }

  extractScripts(code, file) {
    const extracted = this.processor.preprocess(code, file);
    const kinds = new Map();
    const bindings = new Map();
    const unusedBindings = new Map();
    if (extracted.length > 1) {
      const template = this.astroParser.parseTemplate(code);
      const frontmatter = template.result.ast.frontmatter?.program;
      const content = frontmatter ? code.slice(frontmatter.start, frontmatter.end) : "";
      let index = 0;
      template.walk(template.result.ast, (node) => {
        if (!astroClientScript(node)) return;
        const block = extracted[++index];
        const inline = node.openingElement.attributes.some((attr) => attr.name?.name !== "src");
        kinds.set(index, inline ? ts.ScriptKind.JS : ts.ScriptKind.TS);
        const expression = node.openingElement.attributes.find(
          (attr) => attr.name?.name === "define:vars",
        )?.value;
        const variables = expression?.expression;
        if (variables?.type !== "ObjectExpression") return;
        const name = `${astroScriptModulePath(file, index)}.vars.ts`;
        const specifier = JSON.stringify(`./${basename(name)}`);
        bindings.set(name, {
          text: `${content}\nexport default (${code.slice(variables.start, variables.end)});\n`,
        });
        const declarations = declareAstroVariables(block, variables, specifier);
        unusedBindings.set(index, declarations);
      });
    }
    const server = this.untyped ? undefined : this.frontmatter.convert(file, code);
    return {
      extracted,
      unusedBindings,
      server,
      sources: new Map([
        ...extracted
          .slice(1)
          .map(({ text }, index) => [
            astroScriptModulePath(file, index + 1),
            { text, kind: kinds.get(index + 1) },
          ]),
        ...bindings,
        ...(server ? [[file, { text: code }]] : []),
      ]),
    };
  }

  scriptProject(file, root) {
    const config = findAstroTypeScriptProject(file, root);
    const key = config ?? root;
    let project = this.projects.get(key);
    if (!project) {
      const { parsed, options } = astroCompilerOptions(config);
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
        if (findAstroTypeScriptProject(component, root) !== config) continue;
        let entry = this.active.get(component);
        if (!entry) {
          entry = this.extractScripts(
            readFileSync(component, "utf8").replace(/^\uFEFF/, ""),
            component,
          );
          this.processor.postprocess(
            entry.extracted.map(() => []),
            component,
          );
        }
        for (const [name, text] of entry.sources) scripts.set(name, text);
      }
      project = { parsed, options, scripts, folder, program: undefined };
      this.projects.set(key, project);
    }
    return project;
  }

  parse(code, options) {
    if (this.untyped)
      return tseslint.parser.parseForESLint(code, {
        lib: ["esnext", "dom", "dom.iterable"],
        ...options,
      });
    try {
      return this.parseTyped(code, options);
    } catch (error) {
      if (error instanceof Error && !("lineNumber" in error))
        Object.assign(error, { lineNumber: 1, column: 1 });
      throw error;
    }
  }

  parseTyped(code, options) {
    const { component, file, isFrontmatter } = astroBlockFile(options.filePath);
    const project = this.scriptProject(component, options.tsconfigRootDir ?? process.cwd());
    const { scripts } = project;
    const entry = this.active.get(component);
    if (
      (!isFrontmatter && scripts.get(file)?.text !== code) ||
      (entry?.server && scripts.get(component)?.text !== entry.server.source)
    ) {
      for (const [name, source] of entry.sources) scripts.set(name, source);
      project.program = undefined;
    }
    const program = this.cachedProgram(project);
    return tseslint.parser.parseForESLint(code, {
      ...options,
      filePath: file,
      projectService: false,
      programs: [program],
    });
  }

  cachedProgram(project) {
    if (!project.program) project.program = compileAstroProject(project, this.frontmatter);
    return project.program;
  }

  preprocess(code, filename) {
    const entry = this.extractScripts(code, filename);
    this.active.set(filename, entry);
    if (!entry.server?.region) return entry.extracted;
    return [...entry.extracted, { filename: frontmatterBlock, text: entry.server.code }];
  }

  postprocess(messages, filename) {
    const entry = this.active.get(filename);
    this.active.delete(filename);
    remapAstroVariableMessages(messages, entry?.unusedBindings ?? []);
    const client = this.processor.postprocess(messages.slice(0, entry?.extracted.length), filename);
    return entry?.server?.region
      ? [...client, ...frontmatterMessages(entry.server, messages[entry.extracted.length] ?? [])]
      : client;
  }
}

export function astroTypePrograms(processor, astroParser) {
  const programs = new AstroScriptPrograms(processor, astroParser);
  return {
    parser: {
      meta: { ...tseslint.parser.meta, name: "scaffolding/astro-script-parser" },
      parseForESLint(code, options) {
        return programs.parse(code, options);
      },
    },
    preprocess: (code, filename) => programs.preprocess(code, filename),
    postprocess: (messages, filename) => programs.postprocess(messages, filename),
  };
}
