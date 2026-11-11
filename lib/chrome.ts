// From puppeteer's own cache, so puppeteer launched without executablePath starts the same build,
// and never the user's own Chrome, whose headless instance macOS activates in front of the user's
// window. A caller starting the binary itself passes chromeArgs; puppeteer takes
// the binary as `executablePath` and NO_KEYCHAIN as args.
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
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
const BROWSERS = "@puppeteer/browsers@3.2.7";
const install = (shell?: boolean, path = cache()) => [
  BROWSERS,
  "install",
  `${kindOf(shell)}@${pinnedBuild(shell) ?? "stable"}`,
  "--path",
  path,
  "--format",
  "{{path}}",
];

// @puppeteer/browsers downloads <build id>-<file> beside the build's folder, unpacks it there and
// deletes it after, so the folder holds the executable long before it is whole. An archive written
// within UNPACK_WAIT_MS is an unpack under way; an older one is an install that died or hangs: one
// hung 15 minutes while gates took its half-unpacked build.
const UNPACK_WAIT_MS = 120_000;
const UNPACK_POLL_MS = 500;
const writtenAgo = (path: string) => {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};
const archivesOf = (build: string, names: string[]) =>
  names.filter((name) => name.startsWith(`${build.slice(build.indexOf("-") + 1)}-`));
function stateOf(folder: string, build: string, names = readdirSync(folder)) {
  const archives = archivesOf(build, names);
  if (archives.length === 0) return "whole";
  return archives.some((name) => writtenAgo(join(folder, name)) < UNPACK_WAIT_MS)
    ? "unpacking"
    : "died";
}

/** The build puppeteer-core pins, else, without puppeteer-core, the newest build in the cache for
 * this platform. `shell` takes chrome-headless-shell, which printed in 2 s on a Mac where the full
 * app's --print-to-pdf never returned. `anyBuild` takes the newest cached build whatever the pin. */
export const cachedChrome = (options: Options & { anyBuild?: boolean } = {}): string | undefined =>
  scan(options).path;

function scan({ shell, anyBuild }: Options & { anyBuild?: boolean }) {
  const kind = kindOf(shell);
  const pinned = anyBuild ? undefined : pinnedBuild(shell);
  const builds = join(cache(), kind);
  const exe = shell
    ? "chrome-headless-shell"
    : process.platform === "darwin"
      ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      : "chrome";
  // puppeteer's folder names: <platform>-<build id>, beside its .metadata file.
  const platform =
    process.platform === "darwin" ? (process.arch === "arm64" ? "mac_arm" : "mac") : "linux";
  const names = existsSync(builds) ? readdirSync(builds) : [];
  const matching = names.filter((build) =>
    pinned ? build === `${platform}-${pinned}` : build.startsWith(`${platform}-`),
  );
  const path = matching
    .filter((build) => stateOf(builds, build, names) === "whole")
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
    .flatMap((build) =>
      readdirSync(join(builds, build))
        .filter((dir) => dir.startsWith(`${kind}-`))
        .map((dir) => join(builds, build, dir, exe)),
    )
    .find((path) => existsSync(path));
  const unpacking =
    !path && matching.some((build) => stateOf(builds, build, names) === "unpacking");
  return { path, unpacking };
}

// Per install command, so a changed pin, cache folder or kind looks again. Only a found path is
// kept: a failed install runs again on the next call.
const known = new Map<string, string>();
const installs = new Map<string, Promise<string | undefined>>();

function lookup(options: Options) {
  const key = install(options.shell).join("\0");
  const kept = known.get(key);
  const found = kept && existsSync(kept) ? { path: kept, unpacking: false } : scan(options);
  if (found.path) known.set(key, found.path);
  return { key, ...found };
}

// An install unpacks into a folder of its own and moves the whole build into the cache, so no reader
// takes it half unpacked and two installs never write one folder: one in the cache's own folder
// returned another's half-unpacked build at once and deleted the archive that marked it. A staging
// folder an hour old is a killed install's.
function stage(): string | undefined {
  try {
    mkdirSync(cache(), { recursive: true });
    for (const name of readdirSync(cache()))
      if (name.startsWith(".install-") && writtenAgo(join(cache(), name)) > 3_600_000)
        rmSync(join(cache(), name), { recursive: true, force: true });
    return mkdtempSync(join(cache(), ".install-"));
  } catch {
    return undefined;
  }
}

/** The installed executable, moved from `staged` into the cache in place of a build whose install
 * died; undefined where the install failed or another job's unpack of the build is under way. */
function place(staged: string | undefined, output: string): string | undefined {
  if (!staged) return undefined;
  try {
    const installed = output.trim();
    const rel = relative(staged, installed);
    if (!installed || rel.startsWith("..")) return undefined;
    const [kind, build] = rel.split(sep);
    const folder = join(cache(), kind);
    mkdirSync(folder, { recursive: true });
    // A build folder with no archive and no executable is an unpack that threw: @puppeteer/browsers
    // deletes the archive either way.
    const state = existsSync(join(folder, build)) ? stateOf(folder, build) : undefined;
    const path = join(cache(), rel);
    const died = state === "died" || (state === "whole" && !existsSync(path));
    for (const name of archivesOf(build, readdirSync(folder)))
      if (writtenAgo(join(folder, name)) >= UNPACK_WAIT_MS)
        rmSync(join(folder, name), { force: true });
    try {
      if (died) renameSync(join(folder, build), join(staged, "died"));
    } catch {
      /* another install replaced it first */
    }
    try {
      renameSync(join(staged, kind, build), join(folder, build));
    } catch {
      /* another install moved the same build in first */
    }
    return existsSync(path) && stateOf(folder, build) === "whole" ? path : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      rmSync(staged, { recursive: true, force: true });
    } catch {
      /* swept an hour on */
    }
  }
}

/** CHROME_BINARY, else the cached build, else that build (or stable) installed into the cache,
 * blocking; undefined when the install fails, so a test can skip and a command can say how to
 * install. */
export function chromeBinary(options: Options = {}): string | undefined {
  if (process.env.CHROME_BINARY) return process.env.CHROME_BINARY;
  let found = lookup(options);
  for (
    const end = Date.now() + UNPACK_WAIT_MS;
    !found.path && found.unpacking && Date.now() < end;
  ) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, UNPACK_POLL_MS);
    found = lookup(options);
  }
  const { key, path } = found;
  if (path) return path;
  const staged = stage();
  let output = "";
  try {
    if (staged)
      output = execFileSync("bunx", install(options.shell, staged), { encoding: "utf-8" });
  } catch {
    /* a failed install: undefined below */
  }
  const installed = place(staged, output);
  if (installed) known.set(key, installed);
  return installed;
}

/** The same without blocking the process, for a server answering a request meanwhile. Concurrent
 * calls share one install, since two downloads into the same folder collide. */
export async function chromeBinaryAsync(options: Options = {}): Promise<string | undefined> {
  if (process.env.CHROME_BINARY) return process.env.CHROME_BINARY;
  let found = lookup(options);
  for (
    const end = Date.now() + UNPACK_WAIT_MS;
    !found.path && found.unpacking && Date.now() < end;
  ) {
    await new Promise((go) => setTimeout(go, UNPACK_POLL_MS));
    found = lookup(options);
  }
  const { key, path } = found;
  if (path) return path;
  const running = installs.get(key);
  if (running) return running;
  const staged = stage();
  const output = staged
    ? promisify(execFile)("bunx", install(options.shell, staged), { encoding: "utf-8" }).then(
        ({ stdout }) => stdout,
        () => "",
      )
    : Promise.resolve("");
  const started = output
    .then((stdout) => place(staged, stdout))
    .then((installed) => {
      installs.delete(key);
      if (installed) known.set(key, installed);
      return installed;
    });
  installs.set(key, started);
  return started;
}

export const INSTALL_HINT = `Chrome for Testing is required: bunx ${BROWSERS} install chrome@<the build node_modules/puppeteer-core/lib/puppeteer/revisions.js pins, else stable> --path ~/.cache/puppeteer, or set CHROME_BINARY.`;

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
