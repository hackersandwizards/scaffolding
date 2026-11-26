import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cruise, type IDependency, type IModule, type ICruiseResult } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import type { Finding } from "./repo.ts";

const check = "cycles";
export const sourceExtension = /\.[cm]?[jt]sx?$/;
const relativeImport = /^\.\.?\//;
const installedPackage = /(^|\/)node_modules\//;
const isAbsoluteOrParentPath = (path: string) =>
  isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`);
export const cycleFinding = (message: string, path = "package.json"): Finding => ({
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

export type ResolvedImport = { target: string; specifier: string; system: string };
export type ResolvedSource = {
  source: string;
  file: string;
  imports: ResolvedImport[];
  sourceCode?: string;
};
export type VisitImports = (module: ResolvedSource) => void;
export type GraphResult = { complete: boolean; findings: Finding[]; hasRuntimeCycle?: boolean };

type ImportMirror = { directory: string; originals: ReadonlyMap<string, string> };

export class ImportOrigin {
  readonly root: string;
  private readonly mirror?: ImportMirror;

  constructor(root: string, mirror?: ImportMirror) {
    this.root = root;
    this.mirror = mirror;
  }

  get baseDir() {
    return this.mirror?.directory ?? this.root;
  }
  get hasMirror() {
    return this.mirror !== undefined;
  }

  originalPath(path: string) {
    return this.mirror?.originals.get(path) ?? path;
  }

  dependencyTarget(dependency: IDependency, source: string) {
    const { root, baseDir } = this;
    const { module: specifier, resolved, couldNotResolve } = dependency;
    const isRelative = relativeImport.test(specifier);
    const inMirror = baseDir !== root && !isAbsoluteOrParentPath(resolved);
    // A relative path may leave the mirror without leaving the checkout, and files omitted
    // from the mirror (such as assets) can still exist beside the original source.
    const needsOriginalResolution =
      couldNotResolve || (isRelative && baseDir !== root && !inMirror);
    return needsOriginalResolution
      ? isRelative && resolveRelativeImport(root, specifier, source)
      : resolve(inMirror ? root : baseDir, this.originalPath(resolved));
  }

  inspect(dependency: IDependency, source: string): { target?: string; issue?: Finding } {
    if (dependency.coreModule || dependency.protocol) return {};
    const { root } = this;
    const specifier = dependency.module;
    const target = this.dependencyTarget(dependency, source);

    if (!target)
      return relativeImport.test(specifier)
        ? {
            issue: {
              ...cycleFinding(
                "relative import does not resolve to a file: fix the typo, add the missing file or extension, or remove the dead import",
                source,
              ),
              text: specifier,
            },
          }
        : {};
    if (installedPackage.test(relative(root, target).split(sep).join("/"))) return {};

    const path = relative(root, realpathSync(target));
    if (isAbsoluteOrParentPath(path))
      return {
        issue: {
          ...cycleFinding(
            "import leaves the checkout: take another repository's code from its published package, never from a sibling path",
            source,
          ),
          text: `${specifier} -> ${path}`,
        },
      };
    return { target: path.split(sep).join("/") };
  }
}

export function cruiseImportFiles(directory: ImportOrigin, files: string[]) {
  const { root, baseDir } = directory;
  // The tsconfig carries the path aliases; without it an aliased import resolves to nothing and a
  // cycle through it passes.
  const tsconfig = join(baseDir, "tsconfig.json");
  const aliases = existsSync(tsconfig);
  const originalConfig = join(root, "tsconfig.json");
  return cruise(
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
    directory.hasMirror
      ? {
          extensionAlias: { ".astro": [".astro.ts", ".astro"] },
          // The mirrored aliases resolve first. Retry against the real config so a mapping
          // that points out of the checkout resolves from the config's original location.
          ...(aliases ? { tsconfig: originalConfig } : {}),
        }
      : undefined,
    aliases ? { tsConfig: extractTSConfig(tsconfig) } : undefined,
  );
}

export function runtimeCycleFindings(
  violations: ICruiseResult["summary"]["violations"],
  directory: ImportOrigin,
): Finding[] {
  // Every module on a cycle reports it once: keep one finding per set of modules.
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const violation of violations) {
    const cycle = (violation.cycle ?? []).map((step) => step.name);
    const key = [...cycle].sort().join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      check,
      path: directory.originalPath(violation.from),
      text: [violation.from, ...cycle].map((path) => directory.originalPath(path)).join(" -> "),
      message:
        "runtime import cycle: move what both sides need into a module neither imports back from, or import the type with `import type`",
    });
  }
  return findings;
}

export function inspectCruisedModules(
  modules: Pick<IModule, "source" | "dependencies">[],
  directory: ImportOrigin,
  visit?: VisitImports,
): Finding[] {
  const findings: Finding[] = [];
  for (const { source, dependencies } of modules) {
    if (isAbsoluteOrParentPath(source) || installedPackage.test(source)) continue;
    const path = directory.originalPath(source);
    const imports: ResolvedImport[] = [];
    for (const dependency of dependencies) {
      const { issue, target } = directory.inspect(dependency, path);
      if (issue) findings.push(issue);
      if (visit && target)
        imports.push({ target, specifier: dependency.module, system: dependency.moduleSystem });
    }
    if (visit && imports.length)
      visit({ source: path, file: join(directory.baseDir, source), imports });
  }
  return findings;
}

export async function checkImports(
  directory: ImportOrigin,
  files: string[],
  visit?: VisitImports,
): Promise<GraphResult> {
  const { output } = await cruiseImportFiles(directory, files);
  if (typeof output === "string")
    return {
      complete: false,
      findings: [
        cycleFinding(
          "dependency-cruiser returned no result: run bun install and check tsconfig.json and the source files for syntax errors, then re-run check-cycles",
        ),
      ],
    };
  if (output.summary.totalCruised === 0)
    return {
      complete: false,
      findings: [
        cycleFinding(
          `none of ${files.length} files was read: check tsconfig.json and run bun install so dependency-cruiser can parse the repository's source files`,
        ),
      ],
    };

  const cycles = runtimeCycleFindings(output.summary.violations, directory);
  const findings = inspectCruisedModules(output.modules, directory, visit);
  return { complete: true, findings: [...cycles, ...findings], hasRuntimeCycle: cycles.length > 0 };
}
