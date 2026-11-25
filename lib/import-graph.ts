import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { allExtensions, cruise, type IDependency } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import { git, isObject, submodulePaths, type Finding } from "./repo.ts";
const check = "cycles";
const sourceExtension = /\.[cm]?[jt]sx?$/;
const relativeImport = /^\.\.?\//;
const installedPackage = /(^|\/)node_modules\//;
const outside = (path: string) => isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`);
const finding = (message: string, path = "package.json"): Finding => ({
  check,
  path,
  text: "",
  message,
});

function resolveRelativeImport(root: string, specifier: string, source: string) {
  const file = specifier.split(/[?#]/, 1)[0];
  const directory = dirname(join(root, source));
  const exactPath = resolve(directory, file);
  if (statSync(exactPath, { throwIfNoEntry: false })?.isFile()) return exactPath;
  try {
    return Bun.resolveSync(file, directory);
  } catch {
    return undefined;
  }
}

function inspectImport(
  root: string,
  dependency: IDependency,
  source: string,
  baseDir: string,
  originalPath: (path: string) => string,
): { target?: string; issue?: Finding } {
  if (dependency.coreModule || dependency.protocol) return {};
  const { module: specifier, resolved, couldNotResolve } = dependency;
  const isRelative = relativeImport.test(specifier);
  const inMirror = baseDir !== root && !outside(resolved);
  // A relative path may leave the mirror without leaving the checkout, and files omitted
  // from the mirror (such as assets) can still exist beside the original source.
  const needsOriginalResolution = couldNotResolve || (isRelative && baseDir !== root && !inMirror);
  const target = needsOriginalResolution
    ? isRelative && resolveRelativeImport(root, specifier, source)
    : resolve(inMirror ? root : baseDir, originalPath(resolved));

  if (!target)
    return isRelative
      ? {
          issue: {
            ...finding(
              "relative import does not resolve to a file: fix the typo, add the missing file or extension, or remove the dead import",
              source,
            ),
            text: specifier,
          },
        }
      : {};
  if (installedPackage.test(relative(root, target).split(sep).join("/"))) return {};

  const path = relative(root, realpathSync(target));
  if (outside(path))
    return {
      issue: {
        ...finding(
          "import leaves the checkout: take another repository's code from its published package, never from a sibling path",
          source,
        ),
        text: `${specifier} -> ${path}`,
      },
    };
  return { target: path.split(sep).join("/") };
}

type ResolvedImport = { target: string; specifier: string; system: string };
type VisitImports = (
  source: string,
  file: string,
  imports: ResolvedImport[],
  sourceCode?: string,
) => void;
type GraphResult = { complete: boolean; findings: Finding[] };

async function checkImports(
  root: string,
  baseDir: string,
  files: string[],
  visit?: VisitImports,
  astroPaths?: Map<string, string>,
): Promise<GraphResult> {
  // The tsconfig carries the path aliases; without it an aliased import resolves to nothing and a
  // cycle through it passes.
  const tsconfig = join(baseDir, "tsconfig.json");
  const aliases = existsSync(tsconfig);
  const originalConfig = join(root, "tsconfig.json");
  const { output } = await cruise(
    files,
    {
      baseDir,
      validate: true,
      tsPreCompilationDeps: false,
      doNotFollow: { path: "node_modules|^\\.\\./" },
      ...(aliases ? { tsConfig: { fileName: tsconfig } } : {}),
      ruleSet: {
        forbidden: [{ name: check, severity: "error", from: {}, to: { circular: true } }],
      },
    },
    astroPaths
      ? {
          extensionAlias: { ".astro": [".astro.ts", ".astro"] },
          // The mirrored aliases resolve first. Retry against the real config so a mapping
          // that points out of the checkout resolves from the config's original location.
          ...(aliases ? { tsconfig: originalConfig } : {}),
        }
      : undefined,
    aliases ? { tsConfig: extractTSConfig(tsconfig) } : undefined,
  );
  if (typeof output === "string")
    return {
      complete: false,
      findings: [
        finding(
          "dependency-cruiser returned no result: run bun install and check tsconfig.json and the source files for syntax errors, then re-run check-cycles",
        ),
      ],
    };
  if (output.summary.totalCruised === 0)
    return {
      complete: false,
      findings: [
        finding(
          `none of ${files.length} files was read: check tsconfig.json and run bun install so dependency-cruiser can parse the repository's source files`,
        ),
      ],
    };

  const originalPath = (path: string) => astroPaths?.get(path) ?? path;
  // Every module on a cycle reports it once: keep one finding per set of modules.
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const violation of output.summary.violations) {
    const cycle = (violation.cycle ?? []).map((step) => step.name);
    const key = [...cycle].sort().join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      check,
      path: originalPath(violation.from),
      text: [violation.from, ...cycle].map(originalPath).join(" -> "),
      message:
        "runtime import cycle: move what both sides need into a module neither imports back from, or import the type with `import type`",
    });
  }
  for (const { source, dependencies } of output.modules) {
    if (outside(source) || installedPackage.test(source)) continue;
    const path = originalPath(source);
    const imports: ResolvedImport[] = [];
    for (const dependency of dependencies) {
      const { issue, target } = inspectImport(root, dependency, path, baseDir, originalPath);
      if (issue) findings.push(issue);
      if (visit && target)
        imports.push({ target, specifier: dependency.module, system: dependency.moduleSystem });
    }
    if (visit && imports.length) visit(path, join(baseDir, source), imports);
  }
  return { complete: true, findings };
}

function astroFrontmatterCode(source: string, ast: unknown) {
  if (!isObject(ast)) throw new Error("cannot read the Astro syntax tree");
  const { frontmatter } = ast;
  if (frontmatter == null) return "";
  if (isObject(frontmatter) && isObject(frontmatter.program)) {
    const { start, end } = frontmatter.program;
    if (typeof start === "number" && typeof end === "number") return source.slice(start, end);
  }
  throw new Error("cannot read the Astro frontmatter source range");
}

async function checkAstroImports(
  root: string,
  files: string[],
  sources: string[],
  astro: string[],
  visit?: VisitImports,
): Promise<GraphResult> {
  const compiler = await import("@astrojs/compiler-rs").catch(() => undefined);
  if (!compiler)
    return {
      complete: false,
      findings: [finding("cannot load @astrojs/compiler-rs: run bun install")],
    };

  let cache = root;
  for (const directory of ["node_modules", ".cache", "scaffolding"]) {
    cache = join(cache, directory);
    mkdirSync(cache, { recursive: true });
    if (realpathSync(cache) !== cache)
      return {
        complete: false,
        findings: [
          finding(
            "the cycles cache path contains a symlink: replace node_modules/.cache/scaffolding (or a symlinked parent) with a real directory by removing the symlink and running bun install",
          ),
        ],
      };
  }
  const mirror = mkdtempSync(join(cache, "cycles-"));
  try {
    for (const path of files) {
      if (!sourceExtension.test(path) && !/(^|\/)(package|tsconfig[^/]*)\.json$/.test(path))
        continue;
      const target = join(mirror, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, path), target, constants.COPYFILE_EXCL);
    }

    const astroPaths = new Map<string, string>();
    const frontmatter = new Map<string, string>();
    const findings: Finding[] = [];
    const writeModule = (module: string, path: string, code: string) => {
      const target = join(mirror, module);
      mkdirSync(dirname(target), { recursive: true });
      try {
        writeFileSync(target, code, { flag: "wx" });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        const tracked = git(["ls-files", "-z", "--cached", "--", `:(literal)${module}`], root)
          .toString()
          .split("\0")
          .includes(module);
        findings.push(
          finding(
            tracked
              ? "a tracked file collides with the compiled module name"
              : "the compiled module name is already in use",
            path,
          ),
        );
        return;
      }
      astroPaths.set(module, path);
    };
    for (const path of astro) {
      const code = readFileSync(join(root, path), "utf8");
      const result = compiler.transform(code, { filename: path });
      const errors = result.diagnostics.filter(({ severity }) => severity === "error");
      if (errors.length) {
        findings.push(...errors.map(({ text }) => finding(text, path)));
        continue;
      }

      // Compiler-generated virtual imports resolve back to the component.
      const virtualImport = `import ${JSON.stringify(path).slice(0, -1)}?astro&type=`;
      const server = result.code.split("\n").filter((line) => !line.startsWith(virtualImport));
      const module = `${path}.ts`;
      writeModule(module, path, server.join("\n"));
      // The server bundle repeats frontmatter imports to populate Astro's metadata.
      if (visit)
        frontmatter.set(join(mirror, module), astroFrontmatterCode(code, compiler.parse(code).ast));
      for (const [index, script] of result.scripts.entries()) {
        if (script.code) writeModule(`${path}.script-${index}.ts`, path, script.code);
      }
    }
    if (findings.length) return { complete: false, findings };
    const visitSource: VisitImports | undefined =
      visit && ((source, file, imports) => visit(source, file, imports, frontmatter.get(file)));
    return await checkImports(
      root,
      mirror,
      [...sources, ...astroPaths.keys()],
      visitSource,
      astroPaths,
    );
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}

export async function inspectImportGraph(
  directory: string,
  visit?: VisitImports,
): Promise<GraphResult> {
  const root = realpathSync(directory);
  const submodules = submodulePaths(root);
  const insideSubmodule = (path: string) =>
    submodules.some((submodule) => path === submodule || path.startsWith(`${submodule}/`));
  const files = git(["ls-files", "-z", "--cached", "--deduplicate"], root)
    .toString()
    .split("\0")
    .filter((path) => path && !insideSubmodule(path) && existsSync(join(root, path)));
  const sources = files.filter((path) => sourceExtension.test(path));
  const astro = files.filter((path) => path.endsWith(".astro"));
  if (sources.length === 0 && astro.length === 0) return { complete: true, findings: [] };
  // Without a TypeScript compiler, dependency-cruiser silently skips TypeScript modules.
  if (
    (astro.length > 0 || sources.some((path) => /\.[cm]?tsx?$/.test(path))) &&
    !allExtensions.some((e) => e.extension === ".ts" && e.available)
  )
    return {
      complete: false,
      findings: [finding("dependency-cruiser cannot read TypeScript here: run bun install")],
    };

  const visitLocal: VisitImports | undefined =
    visit &&
    ((source, file, imports, sourceCode) => {
      if (!insideSubmodule(source))
        visit(
          source,
          file,
          imports.filter(({ target }) => !insideSubmodule(target)),
          sourceCode,
        );
    });
  return astro.length
    ? checkAstroImports(root, files, sources, astro, visitLocal)
    : checkImports(root, root, sources, visitLocal);
}
