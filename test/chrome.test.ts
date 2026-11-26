import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { cachedChrome, chromeBinary } from "../lib/chrome.ts";
import { testDirectory } from "./test-directory.ts";

afterEach(() => vi.unstubAllEnvs());

test("Chrome surfaces a puppeteer pin module that cannot load its own dependency", () => {
  using fixture = testDirectory();
  const pkg = join(fixture.folder, "node_modules/puppeteer-core");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ exports: { "./internal/revisions.js": "./revisions.cjs" } }),
  );
  writeFileSync(join(pkg, "revisions.cjs"), 'require("./missing-pin-dependency.cjs");\n');
  vi.stubEnv("PUPPETEER_CACHE_DIR", join(fixture.folder, "cache"));
  const cwd = process.cwd();
  process.chdir(fixture.folder);
  try {
    expect(() => cachedChrome()).toThrow(/missing-pin-dependency\.cjs/);
  } finally {
    process.chdir(cwd);
  }
});

const catalogFallbackPlatform =
  process.platform === "darwin" ? (process.arch === "arm64" ? "mac_arm" : "mac") : "linux";

const plantInstallerStub = (folder: string) =>
  writeFileSync(join(folder, "bunx"), "#!/bin/sh\nexit 86\n", { mode: 0o755 });

test("Chrome surfaces errors reading a cached archive", () => {
  using fixture = testDirectory();
  vi.stubEnv("PUPPETEER_CACHE_DIR", fixture.folder);
  mkdirSync(join(fixture.folder, "chrome", `${catalogFallbackPlatform}-9.0.1`), {
    recursive: true,
  });
  const archive = join(fixture.folder, "chrome", "9.0.1-chrome-x.zip");
  symlinkSync(archive, archive);
  expect(() => cachedChrome({ anyBuild: true })).toThrow(/ELOOP/);
});

test("Chrome surfaces a cache location that cannot hold a staging directory", () => {
  using fixture = testDirectory();
  const cache = join(fixture.folder, "cache-file");
  writeFileSync(cache, "");
  plantInstallerStub(fixture.folder);
  vi.stubEnv("CHROME_BINARY", "");
  vi.stubEnv("PATH", fixture.folder);
  vi.stubEnv("PUPPETEER_CACHE_DIR", cache);
  expect(() => chromeBinary()).toThrow(/EEXIST|ENOTDIR/);
});

test.each(["chromeBinary", "chromeBinaryAsync"])(
  "%s surfaces an unexpected installer exception",
  (method) => {
    using fixture = testDirectory();
    plantInstallerStub(fixture.folder);
    const chromeModule = join(import.meta.dirname, "../lib/chrome.ts");
    const source = `
    import * as childProcess from "node:child_process";
    import { mock } from "bun:test";
    const unexpected = new Error("unexpected installer exception");
    const fail = () => {
      console.log("installer fault invoked");
      throw unexpected;
    };
    mock.module("node:child_process", () => ({ ...childProcess, execFile: fail, execFileSync: fail }));
    const chrome = await import(${JSON.stringify(chromeModule)});
    try {
      await chrome.${method}();
    } catch (error) {
      if (error === unexpected) console.error("same installer exception surfaced");
      throw error;
    }`;
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", source], {
      cwd: fixture.folder,
      env: {
        ...process.env,
        CHROME_BINARY: "",
        PATH: fixture.folder,
        PUPPETEER_CACHE_DIR: join(fixture.folder, "cache"),
      },
    });
    expect(result.stdout.toString()).toBe("installer fault invoked\n");
    expect(result.exitCode, result.stderr.toString()).toBe(1);
    expect(result.stderr.toString()).toMatch(/^same installer exception surfaced$/m);
  },
);
