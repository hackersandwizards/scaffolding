import { join } from "node:path";
import { validGlob } from "./changed-steps.ts";
import {
  brandProblem,
  brandSteps,
  browserTestProblem,
  fullOnlySteps,
  linksProblem,
  pinsPackage,
  placedSteps,
  serverProblem,
  vitestRun,
} from "./gate-config.ts";
import { ownEntry } from "./own-entry.ts";
import { isObject, isReason, submodulePaths, type Package } from "./repo.ts";

type ScaffoldingConfig = NonNullable<Package["scaffolding"]>;

// Every key of the Package type's scaffolding and no other, or typecheck fails.
const KEYS = new Set(
  Object.keys({
    allow: 0,
    private: 0,
    typecheck: 0,
    test: 0,
    browserTest: 0,
    markdown: 0,
    brand: 0,
    server: 0,
    linkSkips: 0,
    skip: 0,
    check: 0,
    styles: 0,
    licenses: 0,
    changed: 0,
    fullOnly: 0,
  } satisfies Record<keyof ScaffoldingConfig, 0>),
);

// The checks that read scaffolding.allow: an entry naming any other is never read.
const ALLOWS = new Set(["coupling", "confidential", "never-shown", "structure", "spaces"]);

// Quoted for `sh -c`: a package path holding a space failed every bin step.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function scaffoldingBinCommand(home: string, name: string): string {
  return `bun ${shellQuote(join(home, "bin", `${name}.ts`))}`;
}

export function packageScriptCommand(
  scripts: Record<string, string> | undefined,
  command: string,
): string {
  return ownEntry(scripts, command) ? `bun run --silent ${command}` : command;
}

export function validateConfigKeys(config: ScaffoldingConfig): string | undefined {
  for (const key of Object.keys(config))
    if (!KEYS.has(key)) return `unknown key scaffolding.${key}`;
  for (const entry of config.allow ?? [])
    if (!ALLOWS.has(entry.check ?? ""))
      return `scaffolding.allow names no check that reads it: ${entry.check}`;
  return undefined;
}

export function validateRequiredGateFields(pkg: Package): string | undefined {
  const config = pkg.scaffolding ?? {};
  if (!config.test && !config.browserTest && !isReason(config.skip?.test))
    return "scaffolding.test is missing: name the tests, or skip.test with a reason";
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!("@hackersandwizards/admin" in declared) && !isReason(config.skip?.admin))
    return "@hackersandwizards/admin is not pinned: pin it, or skip.admin with a reason";
  return undefined;
}

export function validateGateIntegrations(pkg: Package): string | undefined {
  const config = pkg.scaffolding ?? {};
  for (const problem of [
    brandProblem(pkg),
    serverProblem(config.server),
    linksProblem(config),
    browserTestProblem(config),
  ])
    if (problem) return problem;
  return undefined;
}

export function buildSharedStepMap(
  pkg: Package,
  root: string,
  home: string,
): Record<string, string> {
  const config = pkg.scaffolding ?? {};
  const bin = (name: string) => scaffoldingBinCommand(home, name);
  // A submodule is its own repository's to check: format, lint and styles walk past it.
  const submodules = submodulePaths(root).map((path) => shellQuote(`${path}/**`));
  const ignored = submodules.map((p) => ` --ignore-pattern ${p}`).join("");
  return {
    // Ahead of lint, which waits for it where it runs Astro (below).
    typecheck: `bun --bun ${config.typecheck ?? "tsc --noEmit"}`,
    format: `bun --bun prettier --check --cache --log-level warn .${submodules.map((p) => ` '!'${p}`).join("")}`,
    // No --cache: a typed rule's verdict on a file changes with the types it imports, which the
    // cache, keyed by the file alone, would keep. One process: each worker builds the type program
    // again, which took longer than linting in turn (30 s against 20 s over 540 files).
    lint: `SCAFFOLDING_STAGED_ESLINT=0 bun --bun eslint .${ignored} -f ${shellQuote(join(home, "lib", "eslint-formatter.ts"))}`,
    oxlint: `bun ${shellQuote(join(home, "lib", "oxlint.ts"))}`,
    styles: bin("check-styles"),
    structure: bin("check-structure"),
    coupling: bin("check-coupling"),
    cycles: bin("check-cycles"),
    names: bin("check-names"),
    layers: `${bin("check-layers")} --check`,
    shell: bin("check-shell"),
    python: bin("check-python"),
    terraform: bin("check-terraform"),
    dockerfile: bin("check-dockerfile"),
    workflows: bin("check-workflows"),
    markdown: bin("check-markdown"),
    spaces: bin("check-spaces"),
    // The index: what the next commit holds, judged by its own allow list.
    confidential: `${bin("check-confidential")} --index`,
    licenses: bin("check-licenses"),
    // Tests are shared too: a gate without them is a skip someone wrote down, not one that drifted.
    test: config.browserTest
      ? `bun ${vitestRun.join(" ")} --exclude ${shellQuote(`${config.browserTest}/**`)}`
      : packageScriptCommand(pkg.scripts, config.test ?? ""),
    // The catalog build, so a broken one goes red here rather than on the Pages run.
    catalog: "bun run --silent build",
    admin: "admin-check",
  };
}

export function withServerCommand(
  home: string,
  server: NonNullable<ScaffoldingConfig["server"]>,
  command: string,
): string {
  const flags = [
    server.timeout === undefined ? "" : ` --timeout ${server.timeout}`,
    server.stderr ? " --stderr" : "",
  ].join("");
  return `${scaffoldingBinCommand(home, "with-server")}${flags} ${shellQuote(server.command)} -- ${command}`;
}

export function resolveLocalReplacement(
  step: string,
  local: readonly string[],
  scripts: Record<string, string> | undefined,
): { replacement?: string; problem?: string } {
  const replacement = `check:${step}`;
  if (!local.includes(replacement)) return {};
  if (!isReason(ownEntry(scripts, replacement)))
    return { problem: `scaffolding.check requires a script named ${replacement}` };
  return { replacement };
}

export function brandElementsCommand(
  config: ScaffoldingConfig,
  directory: string,
  home: string,
): { kind: "full"; command: string } | { problem: string } {
  if (config.brand?.elements !== "server" || isReason(config.skip?.elements))
    return { kind: "full", command: `${directory}brand-elements` };
  if (!config.server)
    return { problem: "scaffolding.server is required for a server-backed check" };
  const cmd = directory
    ? `sh -c ${shellQuote(`${directory}exec brand-elements --base "$1"`)} sh {url}`
    : "brand-elements --base {url}";
  return { kind: "full", command: withServerCommand(home, config.server, cmd) };
}

export function resolveBrandStepCommand(
  step: (typeof brandSteps)[number],
  config: ScaffoldingConfig,
  home: string,
): { kind: "shared" | "full"; command: string } | { problem: string } {
  const brand = config.brand;
  const directory = brand?.directory ? `cd ${shellQuote(brand.directory)} && ` : "";
  if (step === "colours") return { kind: "shared", command: `${directory}brand-colours` };
  if (step === "copies") return { kind: "shared", command: "brand-copies" };
  if (step === "retired")
    return {
      kind: "full",
      command: `brand-retired ${(brand?.retired ?? []).map(shellQuote).join(" ")}`,
    };
  return brandElementsCommand(config, directory, home);
}

export class GatePlan {
  readonly shared: Record<string, string>;
  readonly full = new Map<string, string>();
  readonly replacements = new Map<string, string>();

  constructor(shared: Record<string, string>) {
    this.shared = shared;
  }

  addBrandSteps(pkg: Package, home: string): string | undefined {
    if (!pinsPackage(pkg, "@hackersandwizards/brand")) return undefined;
    const config = pkg.scaffolding ?? {};
    const local = (config.check ?? []).flat().filter((step) => !placedSteps.has(step));
    for (const step of brandSteps) {
      const { replacement, problem } = resolveLocalReplacement(step, local, pkg.scripts);
      if (problem) return problem;
      if (replacement) {
        this.replacements.set(step, replacement);
        continue;
      }
      const resolved = resolveBrandStepCommand(step, config, home);
      if ("problem" in resolved) return resolved.problem;
      if (resolved.kind === "shared") this.shared[step] = resolved.command;
      else this.full.set(step, resolved.command);
    }
    return undefined;
  }

  unusedBrandKey(brand: ScaffoldingConfig["brand"]): string | undefined {
    if (!brand) return undefined;
    const serverElements = brand.elements === "server" && this.full.has("elements");
    if (brand.retired !== undefined && !this.full.has("retired")) return "brand.retired";
    if (brand.elements !== undefined && !serverElements) return "brand.elements";
    if (brand.directory !== undefined && !this.shared.colours && !this.full.has("elements"))
      return "brand.directory";
    return undefined;
  }

  unusedConfigKey(config: ScaffoldingConfig): string | undefined {
    const unusedBrand = this.unusedBrandKey(config.brand);
    if (unusedBrand) return unusedBrand;
    if (config.linkSkips !== undefined && !this.full.has("links")) return "linkSkips";
    const serverElements = config.brand?.elements === "server" && this.full.has("elements");
    const serverUsed = this.full.has("links") || this.replacements.has("links") || serverElements;
    return config.server !== undefined && !serverUsed ? "server" : undefined;
  }
}

export function validatePlacedStepEntries(
  entries: readonly string[],
  replacements: ReadonlyMap<string, string>,
  named: ReadonlySet<string>,
): string | undefined {
  const replacedNames = new Set(replacements.values());
  for (const step of new Set(entries)) {
    if (!placedSteps.has(step) && !replacedNames.has(step)) continue;
    if (entries.filter((entry) => entry === step).length > 1)
      return `scaffolding.check lists ${step} more than once`;
    if (placedSteps.has(step) && !named.has(step))
      return `scaffolding.check names no enabled shared step: ${step}`;
  }
  return undefined;
}

export function buildFullOnlyMap(
  config: ScaffoldingConfig,
  local: readonly string[],
):
  | { fullOnly: Map<string, string>; problem?: undefined }
  | { fullOnly?: undefined; problem: string } {
  const fullOnly = new Map([["catalog", "builds the catalog"], ...fullOnlySteps]);
  if (config.fullOnly !== undefined && !isObject(config.fullOnly))
    return { problem: "scaffolding.fullOnly must be a map of steps to reasons" };
  for (const [step, reason] of Object.entries(config.fullOnly ?? {})) {
    if (step !== "test" && !(step.startsWith("check:") && local.includes(step)))
      return { problem: `scaffolding.fullOnly names no eligible step: ${step}` };
    if (!isReason(reason)) return { problem: `scaffolding.fullOnly.${step} has no reason` };
    fullOnly.set(step, reason);
  }
  return { fullOnly };
}

export function buildChangedMappings(
  config: ScaffoldingConfig,
  named: ReadonlySet<string>,
):
  | { mappings: { glob: Bun.Glob; steps: string[] }[]; problem?: undefined }
  | { mappings?: undefined; problem: string } {
  if (config.changed !== undefined && !isObject(config.changed))
    return { problem: "scaffolding.changed must be a map of paths to steps" };
  const mappings: { glob: Bun.Glob; steps: string[] }[] = [];
  for (const [glob, steps] of Object.entries(config.changed ?? {})) {
    if (!validGlob(glob))
      return { problem: `scaffolding.changed["${glob}"] is no repository-relative glob` };
    if (!Array.isArray(steps))
      return { problem: `scaffolding.changed["${glob}"] is no list of steps` };
    if (!steps.length)
      return { problem: `scaffolding.changed["${glob}"] is an empty list of steps` };
    for (const step of steps)
      if (!named.has(step))
        return { problem: `scaffolding.changed["${glob}"] names no step: ${step}` };
    mappings.push({ glob: new Bun.Glob(glob), steps });
  }
  return { mappings };
}

export function usesAstroTypecheck(
  typecheck: string,
  scripts: Record<string, string> | undefined,
): boolean {
  // `bun --bun <name>` runs a package script of that name before a binary.
  return /\bastro\b/.test(
    [typecheck, ...typecheck.split(/\s+/).map((word) => scripts?.[word])].join(" "),
  );
}
