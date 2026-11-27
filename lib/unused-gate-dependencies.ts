import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { buildSharedStepMap, resolveBrandStepCommand } from "./gate-plan.ts";
import { brandSteps, pinsPackage } from "./gate-config.ts";
import { ownEntry } from "./own-entry.ts";
import { isObject, readPackage } from "./repo.ts";
import { scaffoldTools } from "./scaffold-tools.ts";

const home = join(import.meta.dir, "..");
const scaffolding = readPackage(home);

function gateToolCommands(root: string, pkg: ReturnType<typeof readPackage>) {
  const shared = buildSharedStepMap(pkg, root, home);
  const config = pkg.scaffolding ?? {};
  const commands = Object.values(shared);
  for (const name of [config.typecheck, config.test]) {
    const script = name && ownEntry(pkg.scripts, name);
    if (script) commands.push(script);
  }
  if (pinsPackage(pkg, "@hackersandwizards/brand")) {
    for (const step of brandSteps) {
      const resolved = resolveBrandStepCommand(step, config, home);
      if ("command" in resolved) commands.push(resolved.command);
    }
  }
  return commands;
}

export function declaredBinaries(root: string, name: string, workspace = root) {
  let directory = workspace;
  let installed = join(directory, "node_modules", name);
  while (directory.startsWith(root + "/") && !existsSync(join(installed, "package.json"))) {
    directory = dirname(directory);
    installed = join(directory, "node_modules", name);
  }
  const { bin, name: packageName } = readPackage(installed);
  if (typeof bin === "string" && packageName) return [basename(packageName)];
  return isObject(bin) ? Object.keys(bin) : [];
}

export function gateToolDependencies(root: string) {
  const pkg = readPackage(root);
  const name = scaffolding.name;
  if (!name || (pkg.name !== name && !pinsPackage(pkg, name))) return new Set<string>();
  const used = new Set([
    name,
    ...scaffoldTools,
    ...Object.keys(scaffolding.peerDependencies ?? {}),
  ]);
  // Look past `bun --bun` wrappers and `cd … &&` prefixes to find the binaries provided by dependencies.
  const invocations = gateToolCommands(root, pkg).flatMap((command) =>
    Array.from(
      command.matchAll(
        /(?:^|&& )(?:\w+=\S+ )*(?:bun --bun |exec )?([\w@./-]+)(?=\s|$)(?:\s+([\w-]+))?/g,
      ),
      ([, bin, subcommand]) => ({ binary: basename(bin), subcommand }),
    ),
  );
  // Astro's CLI loads @astrojs/check dynamically with getPackage() when running astro check.
  if (invocations.some(({ binary, subcommand }) => binary === "astro" && subcommand === "check"))
    used.add("@astrojs/check");
  const binaries = new Set(invocations.map(({ binary }) => binary));
  for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (declaredBinaries(root, dependency).some((bin) => binaries.has(bin))) used.add(dependency);
  }
  return used;
}
