import { isObject, isReason, type Package } from "./repo.ts";

export const brandSteps = ["colours", "copies", "retired", "elements"] as const;
export const fullBrandSteps = new Map([
  ["retired", "scans generated output"],
  ["elements", "checks rendered elements"],
]);

export function pinsBrand(pkg: Package): boolean {
  return (
    pkg.name !== "@hackersandwizards/brand" &&
    "@hackersandwizards/brand" in
      { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }
  );
}

function relativePath(path: unknown): path is string {
  return (
    isReason(path) && !/^[/-]|[\\\0]/.test(path) && !path.split("/").some((part) => part === "..")
  );
}

export function brandProblem(pkg: Package): string | undefined {
  const config = pkg.scaffolding;
  const brand = config?.brand;
  if (brand !== undefined) {
    if (!pinsBrand(pkg)) return "scaffolding.brand requires a brand pin";
    if (
      !isObject(brand) ||
      Object.keys(brand).some((key) => !["directory", "retired", "elements"].includes(key))
    )
      return "scaffolding.brand accepts directory, retired and elements";
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
  if (
    pinsBrand(pkg) &&
    brand?.retired === undefined &&
    !(config?.check ?? []).flat().includes("check:retired") &&
    !isReason(config?.skip?.retired)
  )
    return "@hackersandwizards/brand is pinned: declare scaffolding.brand.retired, list check:retired, or give skip.retired a reason";
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
    return "scaffolding.server requires a command and accepts timeout and stderr";
  if (
    server.timeout !== undefined &&
    !(
      typeof server.timeout === "number" &&
      server.timeout > 0 &&
      Math.ceil(server.timeout * 1000) <= 2_147_483_647
    )
  )
    return "scaffolding.server.timeout must be a positive number of seconds within the timer range";
  if (server.stderr !== undefined && typeof server.stderr !== "boolean")
    return "scaffolding.server.stderr must be a boolean";
}

const colourInput =
  /\.(?:css|scss|astro|tsx?|mts|cts|jsx?|mjs|cjs|vue|svelte|html|svg|py|json|webmanifest)$/;

export function changedBrandSteps(path: string, directory = "."): string[] {
  if (/(?:^|\/)\.gitignore$/.test(path)) return ["copies", "colours"];
  const scope = directory.replace(/^(?:\.\/)+|\/+$/g, "");
  if (scope !== "." && scope && !path.startsWith(`${scope}/`)) return ["copies"];
  return colourInput.test(path) ? ["copies", "colours"] : ["copies"];
}
