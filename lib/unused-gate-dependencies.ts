import { basename, join } from "node:path";
import { buildSharedStepMap, resolveBrandStepCommand } from "./gate-plan.ts";
import { brandSteps, pinsPackage } from "./gate-config.ts";
import { isObject, readPackage } from "./repo.ts";
import { scaffoldTools } from "./scaffold-tools.ts";

const home = join(import.meta.dir, "..");
const scaffolding = readPackage(home);

function gateToolCommands(root: string, pkg: ReturnType<typeof readPackage>) {
  const shared = buildSharedStepMap(pkg, root, home);
  const config = pkg.scaffolding ?? {};
  const commands = Object.values(shared);
  if (pinsPackage(pkg, "@hackersandwizards/brand")) {
    for (const step of brandSteps) {
      const resolved = resolveBrandStepCommand(step, config, home);
      if ("command" in resolved) commands.push(resolved.command);
    }
  }
  return commands;
}

function declaredBinaries(root: string, name: string) {
  const { bin, name: packageName } = readPackage(join(root, "node_modules", name));
  if (typeof bin === "string" && packageName) return [packageName.split("/").at(-1)];
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
  // Match executable positions in the gate's commands, including Bun commands and brand's cd.
  const commands = gateToolCommands(root, pkg);
  const binaries = new Set(
    commands.flatMap((command) =>
      Array.from(
        command.matchAll(/(?:^|&& )(?:\w+=\S+ )*(?:bun --bun |exec )?([\w@./-]+)(?=\s|$)/g),
        ([, bin]) => basename(bin),
      ),
    ),
  );
  for (const dependency of Object.keys(pkg.devDependencies ?? {})) {
    if (declaredBinaries(root, dependency).some((bin) => bin !== undefined && binaries.has(bin)))
      used.add(dependency);
  }
  return used;
}
