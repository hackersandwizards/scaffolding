// Fails an install by any package manager but bun, whose lockfile would resolve differently than
// bun.lock. Reads only the user agent the package manager sets. Through `globalThis`, because the
// repositories' lint configs disagree on whether Node's globals are declared.
const { process: proc, console: out } = globalThis;
const pm = (proc.env.npm_config_user_agent || "").split("/")[0];

if (pm && pm !== "bun") {
  out.error(
    `\nERROR: This repository uses bun only (detected '${pm}').\nPlease run: bun install\n`,
  );
  proc.exit(1);
}
