// From puppeteer's own cache, so puppeteer launched without executablePath starts the same build,
// and never the user's own Chrome, whose headless instance macOS activates in front of the user's
// window. A caller starting the binary itself passes chromeArgs; puppeteer takes
// the binary as `executablePath` and NO_KEYCHAIN as args.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

type Options = { shell?: boolean };

const cache = () => process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
const kindOf = (shell?: boolean) => (shell ? "chrome-headless-shell" : "chrome");

/** The build the puppeteer-core installed where the process runs pins; undefined without one. */
function pinnedBuild(shell?: boolean): string | undefined {
  try {
    const require = createRequire(join(process.cwd(), "package.json"));
    return require("puppeteer-core/internal/revisions.js").PUPPETEER_REVISIONS[kindOf(shell)];
  } catch {
    return undefined;
  }
}

// Pinned: bunx runs the newest published release of an unpinned package.
const install = (shell?: boolean) => [
  "@puppeteer/browsers@3.2.6",
  "install",
  `${kindOf(shell)}@${pinnedBuild(shell) ?? "stable"}`,
  "--path",
  cache(),
  "--format",
  "{{path}}",
];

/** The build puppeteer-core pins, else, without puppeteer-core, the newest build in the cache for
 * this platform. `shell` takes chrome-headless-shell, which printed in 2 s on a Mac where the full
 * app's --print-to-pdf never returned. */
export function cachedChrome({ shell }: Options = {}): string | undefined {
  const kind = kindOf(shell);
  const pinned = pinnedBuild(shell);
  const builds = join(cache(), kind);
  const exe = shell
    ? "chrome-headless-shell"
    : process.platform === "darwin"
      ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      : "chrome";
  // puppeteer's folder names: <platform>-<build id>, beside its .metadata file.
  const platform =
    process.platform === "darwin" ? (process.arch === "arm64" ? "mac_arm" : "mac") : "linux";
  return (existsSync(builds) ? readdirSync(builds) : [])
    .filter((build) =>
      pinned ? build === `${platform}-${pinned}` : build.startsWith(`${platform}-`),
    )
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
    .flatMap((build) =>
      readdirSync(join(builds, build))
        .filter((dir) => dir.startsWith(`${kind}-`))
        .map((dir) => join(builds, build, dir, exe)),
    )
    .find((path) => existsSync(path));
}

// Per install command, so a changed pin, cache folder or kind looks again. Only a found path is
// kept: a failed install runs again on the next call.
const known = new Map<string, string>();
const installs = new Map<string, Promise<string | undefined>>();

function lookup(options: Options) {
  const args = install(options.shell);
  const key = args.join("\0");
  const kept = known.get(key);
  const path = kept && existsSync(kept) ? kept : cachedChrome(options);
  if (path) known.set(key, path);
  return { args, key, path };
}

/** CHROME_BINARY, else the cached build, else that build (or stable) installed into the cache,
 * blocking; undefined when the install fails, so a test can skip and a command can say how to
 * install. */
export function chromeBinary(options: Options = {}): string | undefined {
  if (process.env.CHROME_BINARY) return process.env.CHROME_BINARY;
  const { args, key, path } = lookup(options);
  if (path) return path;
  try {
    const installed = execFileSync("bunx", args, { encoding: "utf-8" }).trim() || undefined;
    if (installed) known.set(key, installed);
    return installed;
  } catch {
    return undefined;
  }
}

/** The same without blocking the process, for a server answering a request meanwhile. Concurrent
 * calls share one install, since two downloads into the same folder collide. */
export async function chromeBinaryAsync(options: Options = {}): Promise<string | undefined> {
  if (process.env.CHROME_BINARY) return process.env.CHROME_BINARY;
  const { args, key, path } = lookup(options);
  if (path) return path;
  const running = installs.get(key);
  if (running) return running;
  const started = promisify(execFile)("bunx", args, { encoding: "utf-8" })
    .then(
      ({ stdout }) => stdout.trim() || undefined,
      () => undefined,
    )
    .then((installed) => {
      installs.delete(key);
      if (installed) known.set(key, installed);
      return installed;
    });
  installs.set(key, started);
  return started;
}

export const INSTALL_HINT =
  "Chrome for Testing is required: bunx @puppeteer/browsers@3.2.6 install chrome@<the build node_modules/puppeteer-core/lib/puppeteer/revisions.js pins, else stable> --path ~/.cache/puppeteer, or set CHROME_BINARY.";

/** Chrome otherwise asks the macOS keychain for "Chromium Safe Storage", a dialog per launch. */
export const NO_KEYCHAIN = ["--use-mock-keychain", "--password-store=basic"];

/** Headless, in its own profile, so it never attaches to or locks a Chrome the user has open.
 * Without the GPU, so a Mac paints like a CI runner that has none: with it, gradients and blur
 * differed by up to 8 of 255 per channel (Chrome for Testing 156). */
export const chromeArgs = (profile: string) => [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  ...NO_KEYCHAIN,
  `--user-data-dir=${profile}`,
];
