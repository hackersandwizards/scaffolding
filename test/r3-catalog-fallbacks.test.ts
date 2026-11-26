import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import { decodeCatalogPath } from "../catalog/path.ts";
import { renderCatalog } from "../catalog/render.ts";
import { cachedChrome, chromeBinary } from "../lib/chrome.ts";
import { rejection } from "../lib/rejection.ts";
import { testDirectory } from "./test-directory.ts";

afterEach(() => vi.unstubAllEnvs());

test("catalog path decoding surfaces an unexpected decoder error", () => {
  const error = new Error("decoder bug");
  using decoder = vi.spyOn(globalThis, "decodeURIComponent").mockImplementationOnce(() => {
    throw error;
  });
  expect(() => decodeCatalogPath("/catalog/example")).toThrow(error);
  expect(decoder).toHaveBeenCalledWith("/catalog/example");
});

test("catalog frame loading surfaces an error while assigning the decoded HTML", async () => {
  const rendered = renderCatalog({ title: "Catalog", lead: "", groups: [] });
  const script = rendered.slice(rendered.lastIndexOf("<script>") + 8, -9);
  const browser = {
    loadFrame: (_frame: object): unknown => {
      throw new Error("missing catalog frame loader");
    },
    document: { querySelectorAll: () => [] },
    window: { hwCatalog: true },
    PerformanceObserver: {},
    addEventListener: vi.fn(),
    URL,
    location: { href: "https://catalog.example/" },
    fetch: async () => new Response("<head></head>"),
  };
  runInNewContext(
    script.replace("let started=0;", "globalThis.loadFrame=load;let started=0;"),
    browser,
  );
  const frame = {
    dataset: { src: "/preview" },
    hasAttribute: () => true,
    set srcdoc(_html: string) {
      throw new Error("frame setter failed");
    },
  };
  expect(await rejection(Promise.resolve(browser.loadFrame(frame)))).toBe(
    "Error: frame setter failed",
  );
});

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

test("serve surfaces an unexpected error signalling its server", () => {
  const serveModule = join(import.meta.dirname, "../lib/serve.ts");
  const source = `
    import * as childProcess from "node:child_process";
    import { EventEmitter } from "node:events";
    import { mock } from "bun:test";
    mock.module("node:child_process", () => ({
      ...childProcess,
      spawn: () => Object.assign(new EventEmitter(), { pid: 99, kill: () => true }),
    }));
    globalThis.fetch = async () => new Response();
    const unexpected = new Error("unexpected signal error");
    process.kill = () => {
      console.log("signal probe invoked");
      throw unexpected;
    };
    const { serve } = await import(${JSON.stringify(serveModule)});
    const { stop } = await serve(["fixture-server"]);
    try {
      stop();
    } catch (error) {
      if (error === unexpected) console.error("same signal error surfaced");
      throw error;
    }`;
  const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", source]);
  expect(result.stdout.toString()).toBe("signal probe invoked\n");
  expect(result.exitCode, result.stderr.toString()).toBe(1);
  expect(result.stderr.toString()).toMatch(/^same signal error surfaced$/m);
});
