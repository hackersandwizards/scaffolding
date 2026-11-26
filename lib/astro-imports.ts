import {
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  checkImports,
  cycleFinding,
  ImportOrigin,
  sourceExtension,
  type GraphResult,
  type VisitImports,
} from "./import-scan.ts";
import { git, isObject, resolveModuleIfAvailable, type Finding } from "./repo.ts";

export function astroFrontmatterCode(source: string, ast: unknown) {
  if (!isObject(ast)) throw new Error("cannot read the Astro syntax tree");
  const { frontmatter } = ast;
  if (frontmatter == null) return "";
  if (isObject(frontmatter) && isObject(frontmatter.program)) {
    const { start, end } = frontmatter.program;
    if (typeof start === "number" && typeof end === "number") return source.slice(start, end);
  }
  throw new Error("cannot read the Astro frontmatter source range");
}

export function prepareCyclesCache(root: string) {
  let cache = root;
  for (const directory of ["node_modules", ".cache", "scaffolding"]) {
    cache = join(cache, directory);
    mkdirSync(cache, { recursive: true });
    if (realpathSync(cache) !== cache) return undefined;
  }
  return cache;
}

type AstroCompiler = Pick<typeof import("@astrojs/compiler-rs"), "parse" | "transform">;

export class AstroModuleMirror {
  readonly originals = new Map<string, string>();
  readonly frontmatter = new Map<string, string>();

  private readonly root: string;
  readonly directory: string;
  private readonly compiler: AstroCompiler;

  constructor(root: string, directory: string, compiler: AstroCompiler) {
    this.root = root;
    this.directory = directory;
    this.compiler = compiler;
  }

  copySources(files: string[]) {
    for (const path of files) {
      if (!sourceExtension.test(path) && !/(^|\/)(package|tsconfig[^/]*)\.json$/.test(path))
        continue;
      const target = join(this.directory, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(this.root, path), target, constants.COPYFILE_EXCL);
    }
  }

  writeModule(module: string, path: string, code: string): Finding | undefined {
    const target = join(this.directory, module);
    mkdirSync(dirname(target), { recursive: true });
    try {
      writeFileSync(target, code, { flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const tracked = git(["ls-files", "-z", "--cached", "--", `:(literal)${module}`], this.root)
        .toString()
        .split("\0")
        .includes(module);
      return cycleFinding(
        tracked
          ? "a tracked file collides with the compiled module name"
          : "the compiled module name is already in use",
        path,
      );
    }
    this.originals.set(module, path);
  }

  compileComponent(path: string, readFrontmatter: boolean): Finding[] {
    const code = readFileSync(join(this.root, path), "utf8");
    const result = this.compiler.transform(code, { filename: path });
    const errors = result.diagnostics.filter(({ severity }) => severity === "error");
    if (errors.length) return errors.map(({ text }) => cycleFinding(text, path));
    const findings: Finding[] = [];

    // Compiler-generated virtual imports resolve back to the component.
    const virtualImport = `import ${JSON.stringify(path).slice(0, -1)}?astro&type=`;
    const server = result.code.split("\n").filter((line) => !line.startsWith(virtualImport));
    const module = `${path}.ts`;
    const serverProblem = this.writeModule(module, path, server.join("\n"));
    if (serverProblem) findings.push(serverProblem);
    // The server bundle repeats frontmatter imports to populate Astro's metadata.
    if (readFrontmatter)
      this.frontmatter.set(
        join(this.directory, module),
        astroFrontmatterCode(code, this.compiler.parse(code).ast),
      );
    for (const [index, script] of result.scripts.entries()) {
      if (!script.code) continue;
      const problem = this.writeModule(`${path}.script-${index}.ts`, path, script.code);
      if (problem) findings.push(problem);
    }
    return findings;
  }
}

export async function checkAstroImports(
  root: string,
  files: string[],
  visit?: VisitImports,
): Promise<GraphResult> {
  if (resolveModuleIfAvailable("@astrojs/compiler-rs", import.meta.dir) === undefined)
    return {
      complete: false,
      findings: [cycleFinding("cannot load @astrojs/compiler-rs: run bun install")],
    };

  const compiler = await import("@astrojs/compiler-rs");

  const cache = prepareCyclesCache(root);
  if (cache === undefined)
    return {
      complete: false,
      findings: [
        cycleFinding(
          "the cycles cache path contains a symlink: replace node_modules/.cache/scaffolding (or a symlinked parent) with a real directory by removing the symlink and running bun install",
        ),
      ],
    };
  const directory = mkdtempSync(join(cache, "cycles-"));
  try {
    const mirror = new AstroModuleMirror(root, directory, compiler);
    mirror.copySources(files);
    const findings: Finding[] = [];
    for (const path of files) {
      if (path.endsWith(".astro")) findings.push(...mirror.compileComponent(path, Boolean(visit)));
    }
    if (findings.length) return { complete: false, findings };
    const visitSource: VisitImports | undefined =
      visit && ((source) => visit({ ...source, sourceCode: mirror.frontmatter.get(source.file) }));
    return await checkImports(
      new ImportOrigin(root, mirror),
      [...files.filter((path) => sourceExtension.test(path)), ...mirror.originals.keys()],
      visitSource,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
