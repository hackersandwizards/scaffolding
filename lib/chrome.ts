// The one Chrome every repository's scripts, tests and checks start: the Chrome for Testing build
// the repository's installed puppeteer-core pins, from puppeteer's cache, so a script launching
// puppeteer without executablePath starts the same build. Never the user's own Chrome, whose headless instance macOS activates in front
// of the user's window (shown 2026-10-31). CHROME_BINARY overrides. A caller starting the binary
// itself passes chromeArgs; puppeteer takes the binary as `executablePath` and NO_KEYCHAIN as args.
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
 * this platform. `shell` takes chrome-headless-shell, which
 * printed in 2 s on a Mac where the full app's --print-to-pdf never returned (2026-11-02). */
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

/** CHROME_BINARY, else the cached build, else that build (or stable) installed into the cache, blocking; undefined when
 * the install fails, so a test can skip and a command can say how to install. */
export function chromeBinary(options: Options = {}): string | undefined {
  if (process.env.CHROME_BINARY) return process.env.CHROME_BINARY;
  const found = cachedChrome(options);
  if (found) return found;
  try {
    return execFileSync("bunx", install(options.shell), { encoding: "utf-8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The same without blocking the process, for a server answering a request meanwhile. */
export async function chromeBinaryAsync(options: Options = {}): Promise<string | undefined> {
  if (process.env.CHROME_BINARY) return process.env.CHROME_BINARY;
  const found = cachedChrome(options);
  if (found) return found;
  return promisify(execFile)("bunx", install(options.shell), { encoding: "utf-8" }).then(
    ({ stdout }) => stdout.trim() || undefined,
    () => undefined,
  );
}

export const INSTALL_HINT =
  "Chrome for Testing is required: bunx @puppeteer/browsers@3.2.6 install chrome@<the build node_modules/puppeteer-core/lib/puppeteer/revisions.js pins, else stable> --path ~/.cache/puppeteer, or set CHROME_BINARY.";

/** Chrome otherwise asks the macOS keychain for "Chromium Safe Storage", a dialog per launch. */
export const NO_KEYCHAIN = ["--use-mock-keychain", "--password-store=basic"];

/** Headless, in its own profile, so it never attaches to or locks a Chrome the user has open. */
export const chromeArgs = (profile: string) => [
  "--headless=new",
  "--no-first-run",
  ...NO_KEYCHAIN,
  `--user-data-dir=${profile}`,
];
