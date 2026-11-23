#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
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
import { finish, git, listFiles, repoRoot, submodulePaths, type Finding } from "../lib/repo.ts";

const started = performance.now();
const root = realpathSync(repoRoot());
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

function resolveRelativeImport(specifier: string, source: string) {
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
  dependency: IDependency,
  source: string,
  baseDir: string,
  originalPath: (path: string) => string,
): Finding | undefined {
  if (dependency.coreModule || dependency.protocol) return;
  const { module: specifier, resolved, couldNotResolve } = dependency;
  const isRelative = relativeImport.test(specifier);
  const inMirror = baseDir !== root && !outside(resolved);
  // A relative path may leave the mirror without leaving the checkout, and files omitted
  // from the mirror (such as assets) can still exist beside the original source.
  const needsOriginalResolution = couldNotResolve || (isRelative && baseDir !== root && !inMirror);
  const target = needsOriginalResolution
    ? isRelative && resolveRelativeImport(specifier, source)
    : resolve(inMirror ? root : baseDir, originalPath(resolved));

  if (!target)
    return isRelative
      ? { ...finding("relative import does not resolve to a file", source), text: specifier }
      : undefined;
  if (installedPackage.test(relative(root, target).split(sep).join("/"))) return;

  const path = relative(root, realpathSync(target));
  if (outside(path))
    return {
      ...finding(
        "import leaves the checkout: take another repository's code from its published package, never from a sibling path",
        source,
      ),
      text: `${specifier} -> ${path}`,
    };
}

async function checkImports(baseDir: string, files: string[], astroPaths?: Map<string, string>) {
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
  if (typeof output === "string") return [finding("dependency-cruiser returned no result")];
  if (output.summary.totalCruised === 0) return [finding(`none of ${files.length} files was read`)];

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
    for (const dependency of dependencies) {
      const issue = inspectImport(dependency, path, baseDir, originalPath);
      if (issue) findings.push(issue);
    }
  }
  return findings;
}

async function checkAstroImports(files: string[], sources: string[], astro: string[]) {
  const compiler = await import("@astrojs/compiler-rs").catch(() => undefined);
  if (!compiler) return [finding("cannot load @astrojs/compiler-rs: run bun install")];

  let cache = root;
  for (const directory of ["node_modules", ".cache", "scaffolding"]) {
    cache = join(cache, directory);
    mkdirSync(cache, { recursive: true });
    if (realpathSync(cache) !== cache) return [finding("the cycles cache path contains a symlink")];
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
      const result = compiler.transform(readFileSync(join(root, path), "utf8"), { filename: path });
      const errors = result.diagnostics.filter(({ severity }) => severity === "error");
      if (errors.length) {
        findings.push(...errors.map(({ text }) => finding(text, path)));
        continue;
      }

      // Compiler-generated virtual imports resolve back to the component.
      const virtualImport = `import ${JSON.stringify(path).slice(0, -1)}?astro&type=`;
      const server = result.code.split("\n").filter((line) => !line.startsWith(virtualImport));
      writeModule(`${path}.ts`, path, server.join("\n"));
      for (const [index, script] of result.scripts.entries()) {
        if (script.code) writeModule(`${path}.script-${index}.ts`, path, script.code);
      }
    }
    if (findings.length) return findings;
    return await checkImports(mirror, [...sources, ...astroPaths.keys()], astroPaths);
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}

const submodules = submodulePaths(root);
const files = listFiles(root, false).filter(
  (path) => !submodules.some((s) => path.startsWith(`${s}/`)),
);
const sources = files.filter((path) => sourceExtension.test(path));
const astroCandidates = new Set(
  files.filter((path) => path.endsWith(".astro") && !submodules.includes(path)),
);
const astro = astroCandidates.size
  ? git(["ls-files", "-z", "--cached", "--deduplicate", "--", "*.astro"], root)
      .toString()
      .split("\0")
      .filter((path) => astroCandidates.has(path))
  : [];
if (sources.length === 0 && astro.length === 0) finish(check, [], started);
// Without a TypeScript compiler, dependency-cruiser silently skips TypeScript modules.
if (
  (astro.length > 0 || sources.some((path) => /\.[cm]?tsx?$/.test(path))) &&
  !allExtensions.some((e) => e.extension === ".ts" && e.available)
)
  finish(
    check,
    [finding("dependency-cruiser cannot read TypeScript here: run bun install")],
    started,
  );

const findings = astro.length
  ? await checkAstroImports(files, sources, astro)
  : await checkImports(root, sources);
finish(check, findings, started);
