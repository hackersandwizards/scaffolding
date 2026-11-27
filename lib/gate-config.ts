import { isObject, isReason, type Package } from "./repo.ts";

export const brandSteps = ["colours", "copies", "retired", "elements"] as const;
export const fullOnlySteps = new Map([
  ["retired", "scans generated output"],
  ["elements", "checks rendered elements"],
  ["links", "crawls the built site"],
  ["browser-test", "runs the browser test suite after the build"],
]);
export const placedSteps = new Set(["colours", "copies", ...fullOnlySteps.keys()]);

export const vitestRun = ["--bun", "vitest", "run"];

export function browserTestProblem(
  config: NonNullable<Package["scaffolding"]>,
): string | undefined {
  const folder = config.browserTest;
  if (folder === undefined) return;
  if (
    !relativePath(folder) ||
    !/^[\w.-]+(?:\/[\w.-]+)*$/.test(folder) ||
    folder.split("/").includes(".")
  )
    return "scaffolding.browserTest must name a repository-relative folder without glob characters";
  if (config.test !== undefined && config.test !== `bun ${vitestRun.join(" ")}`)
    return "scaffolding.browserTest already supplies the Vitest command; omit scaffolding.test or set it to bun --bun vitest run";
}

export function pinsPackage(pkg: Package, name: string): boolean {
  return (
    pkg.name !== name &&
    [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some(
      (dependencies) => dependencies && Object.hasOwn(dependencies, name),
    )
  );
}

function relativePath(path: unknown): path is string {
  return (
    isReason(path) && !/^[/-]|[\\\0]/.test(path) && !path.split("/").some((part) => part === "..")
  );
}

export function brandSettingsProblem(brand: Record<string, unknown>): string | undefined {
  if (Object.keys(brand).some((key) => !["directory", "retired", "elements"].includes(key)))
    return "scaffolding.brand has an invalid shape or key. In package.json, use an object with only directory, retired and elements as keys.";
  if (brand.directory !== undefined && !relativePath(brand.directory))
    return "scaffolding.brand.directory must be a repository-relative path";
  if (
    brand.retired !== undefined &&
    (!Array.isArray(brand.retired) || !brand.retired.length || !brand.retired.every(relativePath))
  )
    return "scaffolding.brand.retired must be a non-empty list of repository-relative paths";
  if (brand.elements !== undefined && brand.elements !== "server")
    return 'scaffolding.brand.elements must be "server" when declared';
}

export function brandProblem(pkg: Package): string | undefined {
  const config = pkg.scaffolding;
  const brand = config?.brand;
  if (brand !== undefined) {
    if (!pinsPackage(pkg, "@hackersandwizards/brand"))
      return "scaffolding.brand configures checks supplied by @hackersandwizards/brand, which this package does not pin. Pin @hackersandwizards/brand in package.json or remove scaffolding.brand.";
    if (!isObject(brand))
      return "scaffolding.brand has an invalid shape or key. In package.json, use an object with only directory, retired and elements as keys.";
    const problem = brandSettingsProblem(brand);
    if (problem !== undefined) return problem;
  }
  if (pinsPackage(pkg, "@hackersandwizards/brand")) return brandRetiredRequirement(config, brand);
}

export function brandRetiredRequirement(
  config: Package["scaffolding"],
  brand: NonNullable<Package["scaffolding"]>["brand"],
): string | undefined {
  if (
    brand?.retired === undefined &&
    !(config?.check ?? []).flat().includes("check:retired") &&
    !isReason(config?.skip?.retired)
  )
    return "@hackersandwizards/brand is pinned: declare scaffolding.brand.retired, list check:retired, or give skip.retired a reason";
}

export function serverTimeoutFits(seconds: unknown): boolean {
  return typeof seconds === "number" && seconds > 0 && Math.ceil(seconds * 1000) <= 2_147_483_647;
}

export function serverProblem(
  server: NonNullable<Package["scaffolding"]>["server"],
): string | undefined {
  if (server === undefined) return;
  if (
    !isObject(server) ||
    Object.keys(server).some((key) => !["command", "timeout", "stderr"].includes(key)) ||
    !isReason(server.command)
  )
    return "scaffolding.server must be an object with a non-blank command to start the server. Fix the object in package.json using command and, optionally, timeout and stderr.";
  if (server.timeout !== undefined && !serverTimeoutFits(server.timeout))
    return "scaffolding.server.timeout sets how long the gate waits for the server. In package.json, set it to a number greater than 0 and at most 2147483.647 seconds, or omit it for the default.";
  if (server.stderr !== undefined && typeof server.stderr !== "boolean")
    return "scaffolding.server.stderr must be a boolean";
}

export function linksProblem(config: NonNullable<Package["scaffolding"]>): string | undefined {
  const entries = (config.check ?? []).flat();
  if (entries.includes("links") && !config.server)
    return "scaffolding.check lists links, which needs a running site to crawl. Set scaffolding.server.command in package.json to the server startup command or remove links from scaffolding.check.";
  const skips = config.linkSkips;
  if (skips === undefined) return;
  if (
    !Array.isArray(skips) ||
    !skips.every((prefix) => typeof prefix === "string" && prefix.startsWith("/"))
  )
    return "scaffolding.linkSkips must be a list of path prefixes starting with /";
}
