import { existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";

/** PATH without the folder `bun --bun` puts first, whose `node` is Bun itself. */
export function pathWithoutBunNode() {
  const bun = realpathSync(process.execPath);
  return process.env.PATH?.split(delimiter)
    .filter((dir) => {
      const node = join(dir, "node");
      return !existsSync(node) || realpathSync(node) !== bun;
    })
    .join(delimiter);
}
