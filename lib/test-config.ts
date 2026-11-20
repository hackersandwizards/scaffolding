export function usesSharedVitest(config: string): boolean {
  const specifier = "@hackersandwizards/scaffolding/vitest";
  if (!config.includes(specifier)) return false;
  // Read the static export forms after Bun strips comments and TypeScript syntax.
  let js: string;
  try {
    js = new Bun.Transpiler({ loader: "ts" }).transformSync(config);
  } catch {
    return false;
  }
  if (/^export \{ default \} from "@hackersandwizards\/scaffolding\/vitest";$/m.test(js))
    return true;
  const imported = js.match(
    /^import ([\w$]+) from "@hackersandwizards\/scaffolding\/vitest";$/m,
  )?.[1];
  const used = js.match(/^export default (?:mergeConfig\(([\w$]+),|([\w$]+);$)/m);
  return imported !== undefined && imported === (used?.[1] ?? used?.[2]);
}

export function runsMutationWrapper(script: unknown, ownCommand?: string): boolean {
  if (typeof script !== "string") return false;
  const command = script.match(
    /^\s*(?:env\s+)?(?:[a-zA-Z_]\w*=(?:'[^']*'|"[^"]*"|[^\s'";&|<>])*\s+)*(?:bun\s+(?:(?:run|--bun|--no-env-file)\s+)*)?(['"]?)([^\s'";&|<>]+)\1(?=$|[\s;&|<>])/,
  )?.[2];
  return command === "scaffolding-mutation" || (ownCommand !== undefined && command === ownCommand);
}
