import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { brandFallbacks } from "../catalog/fallbacks.ts";
import { catalogPath } from "../catalog/path.ts";
import { loadRoute, rewriteRoute } from "../catalog/route.ts";
import { runOxlint } from "../lib/oxlint.ts";
import { rejection } from "../lib/rejection.ts";
import { gitShellShebangs, shellInput } from "../lib/shell-inputs.ts";
import { shellcheckBinary } from "../lib/shellcheck.ts";
import { indexInputs, trackedInputs } from "../lib/tracked-inputs.ts";
import {
  applyAllow,
  installedCommit,
  isObject,
  jsonObject,
  newestTag,
  readPackage,
  tagCommit,
} from "../lib/repo.ts";
import ownPackage from "../package.json";
import oxlintTemplate from "../template/.oxlintrc.json";
import templateMcp from "../template/.mcp.json";
import templateSettings from "../template/.claude/settings.json";

/** The member of parsed JSON at `path`, undefined where a step meets no object or list. */
const member = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((v, key) => {
    if (isObject(v)) return v[key];
    const list: unknown[] = Array.isArray(v) ? v : [];
    return list[Number(key)];
  }, value);

// A test's own limit stretches with load as the runner's default does: the gate sets
// SCAFFOLDING_TEST_TIMEOUT_MS from the machine's load, 5000 on an idle machine.
const limit = (ms: number) => (ms * Number(process.env.SCAFFOLDING_TEST_TIMEOUT_MS || 5000)) / 5000;

const bin = (name: string) => join(import.meta.dirname, "..", "bin", `${name}.ts`);
const PREVIEW = 'ASTRO_PREVIEW_BACKGROUND=1 bun --bun astro preview --root "$PWD/catalog"';
const made: string[] = [];
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const cache = join(import.meta.dirname, "..", "node_modules", ".cache", "scaffolding");
// A stopped run skips afterAll: the next run removes its folders once an hour old, so a run still
// going keeps its own.
for (const root of [tmpdir(), cache])
  for (const name of existsSync(root) ? readdirSync(root) : [])
    if (name.startsWith("scaffolding-test-"))
      try {
        const dir = join(root, name);
        if (Date.now() - statSync(dir).mtimeMs > 3_600_000)
          rmSync(dir, { recursive: true, force: true });
      } catch {} // another run removed it first
function temp(root = tmpdir()) {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "scaffolding-test-"));
  made.push(dir);
  return dir;
}
/** A headless Chrome on a free debugging port with one tab open at `url`, driven over CDP. The
 * unused debugging pipe on fds 3 and 4 closes when this process dies, killed by a signal included,
 * where no `finally` runs, and Chrome quits on that. */
async function browse(url: string, args: string[] = []) {
  const { chromeArgs, chromeBinary, INSTALL_HINT } = await import("../lib/chrome.ts");
  const { freePort } = await import("../lib/serve.ts");
  const chrome = chromeBinary();
  if (!chrome) throw new Error(INSTALL_HINT);
  const port = await freePort();
  const browser = Bun.spawn(
    [
      chrome,
      ...chromeArgs(temp()),
      `--remote-debugging-port=${port}`,
      "--remote-debugging-pipe",
      ...args,
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  let ws: WebSocket;
  try {
    let target: unknown;
    for (let i = 0; i < 100 && typeof target !== "string"; i++)
      target = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })
        .then(async (r) => member(await r.json(), "webSocketDebuggerUrl"))
        .catch(() => new Promise((r) => setTimeout(r, 100)));
    if (typeof target !== "string") throw new Error("Chrome opened no page to attach to");
    ws = new WebSocket(target);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  } catch (e) {
    browser.kill();
    throw e;
  }
  let id = 0;
  const send = (method: string, params: object = {}) =>
    new Promise<{ value?: unknown }>((done) => {
      const call = ++id;
      const on = (event: MessageEvent) => {
        const message = jsonObject(String(event.data));
        if (message.id !== call) return;
        ws.removeEventListener("message", on);
        const result = member(message, "result", "result");
        done(isObject(result) ? result : {});
      };
      ws.addEventListener("message", on);
      ws.send(JSON.stringify({ id: call, method, params }));
    });
  const evaluate = async (expression: string) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true })).value;
  const until = async (expression: string) => {
    for (const end = Date.now() + 20_000; Date.now() < end;) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out: ${expression}`);
  };
  const close = () => {
    ws.close();
    browser.kill();
  };
  return { ws, send, evaluate, until, close };
}

const sh = (cwd: string, args: string[], input?: string) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, input });

function repo(files: Record<string, string>, commit = true) {
  const dir = temp();
  sh(dir, ["init", "-q", "-b", "main"]);
  write(dir, { ".gitignore": "node_modules\n", ...files });
  if (commit) {
    sh(dir, ["add", "-A"]);
    sh(dir, ["commit", "-qm", "init"]);
  }
  return dir;
}
function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

test.each(["node", "bun"])(
  "the consumer explore command runs only aliased properties on %s and reports the shrunk failing case",
  (runtime) => {
    const dir = temp();
    const property = "sample.prop.test.ts";
    write(dir, {
      "package.json": JSON.stringify({
        name: "property-consumer",
        type: "module",
        scripts: {
          explore: "scaffolding-explore",
          "test:run": runtime === "bun" ? "bun --bun vitest run" : "vitest run",
          ...(runtime === "node" ? { "test:coverage": "vitest run --coverage" } : {}),
        },
        scaffolding: { test: runtime === "node" ? "test:coverage" : "test:run" },
      }),
      "vitest.config.mjs":
        runtime === "node"
          ? `import base from "@hackersandwizards/scaffolding/vitest";
import { mergeConfig } from "vitest/config";
export default mergeConfig(base, {
  test: { coverage: { enabled: true, include: ["uncovered.ts"], thresholds: { lines: 100 } } },
});`
          : 'export { default } from "@hackersandwizards/scaffolding/vitest";\n',
      "uncovered.ts": "export const uncovered = 1;\n",
      [property]: `
import { fc, test as propertyTest } from "@hackersandwizards/scaffolding/property";
import { afterAll, afterEach, beforeEach, expect, test as example } from "vitest";
example("example in a property file (with seed=-188)", () => {
  expect(process.env.SCAFFOLDING_EXPLORING).toBeUndefined();
});
let active = false;
let cases = 0;
beforeEach(() => {
  expect(active).toBe(false);
  active = true;
});
afterEach(() => {
  expect(active).toBe(true);
  active = false;
});
afterAll(() => {
  expect(cases).toBe(fc.readConfigureGlobal().numRuns);
});
propertyTest.prop([fc.integer({ min: 1, max: 100 })])("positive integers", (value) => {
  expect(process.versions.bun === undefined ? "node" : "bun").toBe(${JSON.stringify(runtime)});
  const exploring = process.env.SCAFFOLDING_EXPLORING === "1";
  expect(fc.readConfigureGlobal().seed).toBe(exploring ? -188 : 17401);
  expect(fc.readConfigureGlobal().numRuns).toBe(exploring ? 512 : 64);
  if (exploring) expect(process.env.SCAFFOLDING_TEST_TIMEOUT_MS).toBe("48000");
  expect(active).toBe(true);
  cases++;
  expect(value).toBeGreaterThan(0);
});`,
      "example.prop.test.folder/sample.test.ts": `
import { test } from "vitest";
test("example must stay out of exploration", () => { throw new Error("example ran"); });`,
    });
    const home = join(import.meta.dirname, "..");
    const scope = join(dir, "node_modules", "@hackersandwizards");
    const commands = join(dir, "node_modules", ".bin");
    mkdirSync(scope, { recursive: true });
    mkdirSync(commands, { recursive: true });
    symlinkSync(home, join(scope, "scaffolding"));
    symlinkSync(join(home, "node_modules", "vitest"), join(dir, "node_modules", "vitest"));
    if (runtime === "node")
      symlinkSync(join(home, "node_modules", "@vitest"), join(dir, "node_modules", "@vitest"));
    symlinkSync(bin("scaffolding-explore"), join(commands, "scaffolding-explore"));
    symlinkSync(join(home, "node_modules", ".bin", "vitest"), join(commands, "vitest"));
    const bun = realpathSync(process.execPath);
    const path = process.env.PATH?.split(delimiter)
      .filter((dir) => {
        const node = join(dir, "node");
        return !existsSync(node) || realpathSync(node) !== bun;
      })
      .join(delimiter);
    if (runtime === "node") {
      const control = spawnSync(process.execPath, ["run", "test:coverage", property], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: path },
      });
      const output = control.stdout + control.stderr;
      expect(control.status, output).toBe(1);
      expect(output).toMatch(/Tests\s+2 passed/);
      expect(output).toMatch(/Coverage for lines .* does not meet global threshold/);
    }
    const explore = () =>
      spawnSync(process.execPath, ["run", "explore", "--seed", "-188"], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: path,
          CI: undefined,
          GIT_INDEX_FILE: undefined,
          SCAFFOLDING_CHANGED: undefined,
          SCAFFOLDING_GIT_HOOK: undefined,
          SCAFFOLDING_TEST_TIMEOUT_MS: "6000",
        },
      });
    const passing = explore();
    expect(passing.status, passing.stdout + passing.stderr).toBe(0);
    expect(passing.stdout).toContain("seed -188, 512 runs per property");
    expect(passing.stdout).toMatch(/Tests\s+1 passed/);
    expect(passing.stdout).not.toContain("Coverage enabled");

    const file = join(dir, property);
    writeFileSync(file, readFileSync(file, "utf8").replace("toBeGreaterThan(0)", "toBe(0)"));
    const failing = explore();
    expect(failing.status, failing.stdout + failing.stderr).toBe(1);
    const output = failing.stdout + failing.stderr;
    expect(output).toContain("with seed=-188");
    expect(output).toContain("Counterexample: [1]");

    writeFileSync(file, readFileSync(file, "utf8").replace("toBe(0)", "toBeGreaterThan(0)"));
    writeFileSync(join(dir, "vitest.config.mjs"), "export default {};");
    const direct = spawnSync(process.execPath, ["run", "test:run", property], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: path,
        SCAFFOLDING_EXPLORING: undefined,
        SCAFFOLDING_EXPLORE_SEED: "42",
        SCAFFOLDING_EXPLORE_RUNS: "2",
      },
    });
    expect(direct.status, direct.stdout + direct.stderr).toBe(0);
  },
);

test.each([
  ["CI", "CI", "1"],
  ["git hook", "SCAFFOLDING_GIT_HOOK", "1"],
  ["git hook", "GIT_INDEX_FILE", "index"],
  ["gate", "SCAFFOLDING_CHANGED", "0"],
  ["gate", "SCAFFOLDING_CHANGED", "1"],
])("explore refuses %s before choosing a seed (%s=%s)", (context, variable, value) => {
  const result = spawnSync(process.execPath, ["--no-env-file", bin("scaffolding-explore")], {
    cwd: temp(),
    encoding: "utf8",
    env: {
      ...process.env,
      CI: undefined,
      SCAFFOLDING_GIT_HOOK: undefined,
      GIT_INDEX_FILE: undefined,
      SCAFFOLDING_CHANGED: undefined,
      [variable]: value,
    },
  });
  expect(result.status, result.stdout + result.stderr).toBe(2);
  expect(result.stderr).toContain(context);
  expect(result.stdout).toBe("");
});

test("the installed pre-commit hook marks the commands it calls", () => {
  const dir = repo({
    "package.json": JSON.stringify({
      scripts: {
        "check:staged": `env -u CI -u GIT_INDEX_FILE "${process.execPath}" --no-env-file "${bin("scaffolding-explore")}"`,
      },
    }),
  });
  mkdirSync(join(dir, "node_modules"));
  write(dir, {
    ".githooks/pre-commit": readFileSync(
      join(import.meta.dirname, "../template/.githooks/pre-commit"),
      "utf8",
    ),
  });
  chmodSync(join(dir, ".githooks/pre-commit"), 0o755);
  expect(sh(dir, ["config", "core.hooksPath", ".githooks"]).status).toBe(0);
  const commit = sh(dir, ["commit", "--allow-empty", "-m", "exercise pre-commit"]);
  expect(commit.status).toBe(1);
  expect(commit.stderr.toString()).toContain("cannot run inside a git hook");
  expect(commit.stdout.toString()).not.toContain("seed");
});

test("Vitest assertion lint accepts property callbacks with both assertion rules active", () => {
  const dir = temp();
  const root = join(import.meta.dirname, "..");
  const missing = "missing.prop.test.js";
  const standalone = "standalone.prop.test.js";
  write(dir, {
    ".oxlintrc.json": JSON.stringify({ extends: [join(root, "config/oxlint.json")] }),
    [missing]: 'import { test } from "vitest";\ntest("missing assertion", () => {});',
    [standalone]: `import { expect } from "vitest";\nexpect(true).toBe(true);`,
  });
  const passing = runOxlint(root, ["test/changed-steps.prop.test.ts"], true);
  expect(passing.status, passing.stdout + passing.stderr).toBe(0);
  const failing = runOxlint(dir, [missing, standalone], true);
  expect(failing.status).toBe(1);
  const output = failing.stdout + failing.stderr;
  expect(output).toMatch(/missing\.prop\.test\.js:[^\n]*vitest\(expect-expect\)/);
  expect(output).toMatch(/standalone\.prop\.test\.js:[^\n]*vitest\(no-standalone-expect\)/);
});

test(
  "ESLint enforces the shared property API, budgets and exploration filenames",
  () => {
    const dir = temp();
    const root = join(import.meta.dirname, "..");
    const property = "example.prop.test.js";
    const ordinary = "example.test.js";
    const imports = `import { fc as arbitraries, test as propertyTest } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";`;
    write(dir, {
      "eslint.config.mjs": `export { default } from ${JSON.stringify(join(root, "config/eslint.js"))};`,
    });
    const lint = (path: string, source: string) => {
      write(dir, { [path]: source });
      const result = spawnSync(
        process.execPath,
        ["--bun", join(root, "node_modules/.bin/eslint"), path],
        { cwd: dir, encoding: "utf8" },
      );
      return { status: result.status, output: result.stdout + result.stderr };
    };
    const callback = "(value) => expect(Number.isInteger(value)).toBe(true)";
    const call = (options = "", body = callback) =>
      `propertyTest.prop([arbitraries.integer()]${options})("an integer", ${body});`;
    const shared = (options = "", body = callback) => `${imports}\n${call(options, body)}`;
    expect(lint(property, shared(", { examples: [[1]] }"))).toEqual({ status: 0, output: "" });
    expect(
      lint(
        ordinary,
        'import { test as example, expect } from "vitest"; example("works", () => expect(true).toBe(true));',
      ),
    ).toEqual({
      status: 0,
      output: "",
    });
    expect(
      lint(
        ordinary,
        'import { test, expect } from "vitest"; const fc = { assert: () => true }; test("local helper", () => expect(fc.assert()).toBe(true));',
      ),
    ).toEqual({ status: 0, output: "" });
    const cases = [
      [
        property,
        shared("", "(value) => { Number.isInteger(value); }"),
        "A property callback must assert",
      ],
      [ordinary, shared(), "Move this property to a *.prop.test.* file"],
      [property, shared(", { seed: 1 }"), "Use the shared property seed and case count"],
      [property, shared(', { "numRuns": 1 }'), "Use the shared property seed and case count"],
      [property, shared(", { ...{ numRuns: 1 } }"), "Use the shared property seed and case count"],
      [
        ordinary,
        'import fc from "fast-check"; export const value = fc.integer();',
        "Import from @hackersandwizards/scaffolding/property",
      ],
      [
        ordinary,
        'import { test as propertyTest } from "@fast-check/vitest"; export { propertyTest };',
        "Import from @hackersandwizards/scaffolding/property",
      ],
      [
        ordinary,
        'import { fc } from "@hackersandwizards/scaffolding/property"; fc.assert(fc.property(fc.integer(), () => true));',
        "Use test.prop from @hackersandwizards/scaffolding/property",
      ],
      [
        property,
        `${shared()}\nimport { test as example } from "vitest"; example.each([true])("an example", (value) => expect(value).toBe(true));`,
        "Move this example to an ordinary test file",
      ],
      [
        property,
        'import { test, expect } from "vitest"; test.prop([])("wrong test", () => expect(true).toBe(true));',
        "Use test.prop from @hackersandwizards/scaffolding/property",
      ],
    ];
    for (const [file, source, message] of cases) {
      const result = lint(file, source);
      expect(result.status, source + result.output).toBe(1);
      expect(result.output).toContain(message);
    }
  },
  limit(10_000),
);
// SCAFFOLDING_LOAD 0: the gate runs its steps side by side whatever this machine's load is.
function run(
  cwd: string,
  name: string,
  args: string[] = [],
  env: Record<string, string> = {},
  input?: string,
) {
  const r = spawnSync(process.execPath, ["--no-env-file", bin(name), ...args], {
    cwd,
    env: { ...process.env, SCAFFOLDING_LOAD: "0", ...env },
    encoding: "utf8",
    input,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const lines = (out: string, check: string) =>
  out.split("\n").filter((l) => l.startsWith(`[${check}]`) && !/ findings, \d+ ms$/.test(l));

const fixturePackage = {
  name: "fx",
  type: "module",
  scripts: { gen: "bun ../other/util.ts" },
  dependencies: {
    "@acme/pkg": "github:acme/pkg#v1.2.0",
    "@acme/unpinned": "github:acme/unpinned",
    "@acme/branch": "git+https://github.com/acme/branch.git#main",
    "@acme/local": "file:../other",
    registry: "^1.0.0",
  },
};
const acme = {
  "node_modules/@acme/pkg/package.json": JSON.stringify({
    name: "@acme/pkg",
    version: "1.2.0",
    exports: { "./tokens": "./tokens.ts", "./elements/*": "./elements/*" },
  }),
};

const installed =
  "hard-coded path into an installed package: import.meta.resolve it through the package's exports (its ./package.json for the folder), run its command from node_modules/.bin, serve a catalog asset by its package path in the preset's copy, or name the exception in scaffolding.allow";

test("allow entries: **/ covers the root, list items die alone, a non-string is a finding", () => {
  const allow = (entries: object[], findings: [string, string][]) =>
    applyAllow(
      { scaffolding: { allow: entries } } as Parameters<typeof applyAllow>[0],
      "x",
      findings.map(([path, text]) => ({ check: "x", path, text, message: "m" })),
      true,
    ).map((f) => `${f.path}: ${f.message}${f.path === "package.json" ? ` ${f.text}` : ""}`);
  expect(
    allow(
      [{ check: "x", path: "**/x.ts", reason: "r" }],
      [
        ["x.ts", "t"],
        ["a/b/x.ts", "t"],
      ],
    ),
  ).toEqual([]);
  expect(allow([{ check: "x", path: "a/**/b.ts", reason: "r" }], [["a/b.ts", "t"]])).toEqual([]);
  const pairs = { check: "x", path: ["a", "b"], text: ["x", "y"], reason: "r" };
  expect(
    allow(
      [pairs],
      [
        ["a", "x"],
        ["b", "y"],
      ],
    ),
  ).toEqual([]);
  expect(allow([pairs], [["a", "x"]])).toEqual([
    `package.json: allow entry matches nothing ${JSON.stringify({ ...pairs, path: "b" })}`,
    `package.json: allow entry matches nothing ${JSON.stringify({ ...pairs, text: "y" })}`,
  ]);
  expect(allow([{ check: "x", path: 5, reason: "r" }], [["a", "t"]])).toEqual([
    "a: m",
    'package.json: allow entry\'s path and text are strings or lists of strings {"check":"x","path":5,"reason":"r"}',
  ]);
});

// Before anything else runs: in an empty folder outside a repository, with neither gitleaks nor a
// Chrome to find.
test("every command answers --help first on stdout, and check-lock passes a later --help on", () => {
  const dir = temp();
  const env = { PATH: "/usr/bin:/bin", HOME: dir };
  const help = (path: string, args = ["--help"]) =>
    spawnSync(process.execPath, ["--no-env-file", join(import.meta.dirname, "..", path), ...args], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
  for (const [name, path] of Object.entries(ownPackage.bin)) {
    const r = help(path);
    const usage = r.stdout.split("\n")[0] ?? "";
    expect({ name, status: r.status, stderr: r.stderr, usage }).toEqual({
      name,
      status: 0,
      stderr: "",
      usage: new RegExp(`^usage: ${name}( |$)`).test(usage) ? usage : `usage: ${name}`,
    });
    // Its row of docs/commands.md, which the skeleton's copy of check-lock has no way to read.
    if (name !== "check-lock") expect(r.stdout).toContain("\nRuns in: ");
  }
  expect(help(ownPackage.bin["check-lock"], ["echo", "--help"]).stdout).toBe("--help\n");
});

describe("check-coupling", () => {
  const fx = repo({
    "package.json": JSON.stringify(fixturePackage, null, 2),
    "src/ok.ts":
      'import { t } from "@acme/pkg/tokens";\nimport e from "@acme/pkg/elements/a.css";\nimport { y } from "./in-repo";\n',
    "src/in-repo.ts": "export const y = 1;\n",
    "src/bad-sibling.ts": 'import { x } from "../../other/util";\n',
    "src/bad-exports.ts": 'import { s } from "@acme/pkg/internal/secret.ts";\n',
    "styles/bad.css": '@import "../../other/theme.css";\n@import "@acme/pkg/internal/x.css";\n',
    "src/__tests__/a.test.ts":
      'import { x } from "../../../other/util";\nconst data = "../../../../escape";\n',
    ...acme,
  });

  test("finds each planted case and nothing in the controls", () => {
    const r = run(fx, "check-coupling");
    expect(r.code).toBe(1);
    const found = lines(r.out, "check-coupling");
    expect(found).toHaveLength(10);
    for (const want of [
      "package.json: path leaves the repository; take it from the package its owner publishes (../other/util.ts)",
      "package.json: path leaves the repository; take it from the package its owner publishes (../other)",
      "src/bad-sibling.ts: path leaves",
      "styles/bad.css: path leaves the repository; take it from the package its owner publishes (../../other/theme.css)",
      "src/bad-exports.ts: not in the exports of @acme/pkg",
      "styles/bad.css: not in the exports of @acme/pkg (@acme/pkg/internal/x.css)",
      "Git dependency not pinned to a version tag (@acme/unpinned@github:acme/unpinned)",
      "Git dependency not pinned to a version tag (@acme/branch@",
      "local path dependency (@acme/local@file:../other)",
      "src/__tests__/a.test.ts: path leaves the repository; take it from the package its owner publishes (../../../other/util)",
    ])
      expect(found.some((l) => l.includes(want))).toBe(true);
    expect(r.out).not.toContain("src/ok.ts");
    expect(r.out).not.toContain("escape");
    expect(r.out).not.toContain("registry@");
  });

  test("a Git pin that node_modules does not hold goes red", () => {
    const pinned = (installed?: string) =>
      repo({
        "package.json": JSON.stringify({ dependencies: { "@acme/pkg": "github:acme/pkg#v1.2.0" } }),
        ...(installed && {
          "node_modules/@acme/pkg/package.json": JSON.stringify({ version: installed }),
        }),
      });
    expect(run(pinned("1.2.0"), "check-coupling").code).toBe(0);
    expect(run(pinned("1.1.0"), "check-coupling").out).toContain(
      "node_modules holds 1.1.0, not the pinned 1.2.0",
    );
    expect(run(pinned(), "check-coupling").out).toContain("node_modules holds nothing");
  });

  test("checks only staged files with --staged", () => {
    const dir = repo({ "package.json": "{}", "src/old.ts": 'import "../../x";\n' });
    write(dir, { "src/new.ts": 'import "../../y";\n' });
    sh(dir, ["add", "src/new.ts"]);
    const found = lines(run(dir, "check-coupling", ["--staged"]).out, "check-coupling");
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("src/new.ts");
  });

  test("the full run judges the files the next commit adds, as the commit hook will", () => {
    const dir = repo({ "package.json": "{}", "src/gone.ts": "export {};\n" });
    write(dir, { "catalog/Type.astro": 'const BRAND = "../../node_modules/x";\n' });
    rmSync(join(dir, "src/gone.ts"));
    const want = [
      "[check-coupling] catalog/Type.astro: path leaves the repository; take it from the package its owner publishes (../../node_modules/x)",
    ];
    expect(lines(run(dir, "check-coupling").out, "check-coupling")).toEqual(want);
    sh(dir, ["add", "catalog/Type.astro"]);
    expect(lines(run(dir, "check-coupling", ["--staged"]).out, "check-coupling")).toEqual(want);
  });

  test("CSS from company packages comes only from brand's exports, the shell's only under catalog/", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "@hackersandwizards/fx" }),
      "node_modules/@hackersandwizards/brand/package.json": JSON.stringify({
        exports: {
          "./tokens.css": "./tokens/tokens.css",
          "./fonts/*": "./tokens/fonts/*",
          // A conditional export's target is a target too.
          "./elements.css": {
            style: "./elements/elements.css",
            default: "./elements/elements.css",
          },
        },
      }),
      "src/cond.css": '@import "../node_modules/@hackersandwizards/brand/elements/elements.css";\n',
      "src/fonts.css":
        '@font-face { src: url("../node_modules/@hackersandwizards/brand/tokens/fonts/inter.woff2"); }\n@font-face { src: url(../node_modules/@hackersandwizards/brand/fonts/inter.woff2); }\n@import "../node_modules/@hackersandwizards/brand/tokens.css";\n',
      "src/ok.css": '@import "@hackersandwizards/brand/tokens.css";\n@import "./own.css";\n',
      "src/own.css": "a { color: red; }\n",
      "src/self.ts": 'import "@hackersandwizards/fx/x.css";\n',
      "src/deep.astro":
        '<link rel="stylesheet" href="../node_modules/@hackersandwizards/brand/expert/expert.css" />\n',
      "src/admin.ts": 'import "@hackersandwizards/admin/site.css";\n',
      "src/shell.ts": 'import "@hackersandwizards/scaffolding/catalog/catalog.css";\n',
      "catalog/shell.ts": 'import "@hackersandwizards/scaffolding/catalog/catalog.css";\n',
      "catalog/astro.config.ts": 'export const css = ["@hackersandwizards/documents/doc.css"];\n',
      "test/a.test.ts": 'const planted = "@hackersandwizards/admin/site.css";\n',
      "src/disk.css": '@source "../node_modules/@hackersandwizards/brand/tokens/tokens.css";\n',
      "src/named.css": '@import "@hackersandwizards/brand/tokens/tokens.css";\n',
      "node_modules/@hackersandwizards/slides/package.json": JSON.stringify({
        exports: {
          "./styles/slides.css": "./styles/slides.css",
          "./styles/x.css": "./styles/x.css",
        },
        scaffolding: { styles: ["./styles/slides.css"] },
      }),
      "src/deck.css": '@import "@hackersandwizards/slides/styles/slides.css";\n',
      "src/deck-disk.ts":
        'export const sheet = "./node_modules/@hackersandwizards/slides/styles/slides.css";\n',
      "src/deck-other.css": '@import "@hackersandwizards/slides/styles/x.css";\n',
    });
    const found = lines(run(dir, "check-coupling").out, "check-coupling");
    expect(found.sort()).toEqual([
      "[check-coupling] catalog/astro.config.ts: styles come from brand's exports, an engine's scaffolding.styles or this repository (@hackersandwizards/documents/doc.css)",
      "[check-coupling] src/admin.ts: styles come from brand's exports, an engine's scaffolding.styles or this repository (@hackersandwizards/admin/site.css)",
      `[check-coupling] src/deck-disk.ts: ${installed} (node_modules/@hackersandwizards/slides/styles/slides.css)`,
      "[check-coupling] src/deck-other.css: styles come from brand's exports, an engine's scaffolding.styles or this repository (@hackersandwizards/slides/styles/x.css)",
      `[check-coupling] src/deep.astro: ${installed} (node_modules/@hackersandwizards/brand/expert/expert.css)`,
      "[check-coupling] src/fonts.css: a stylesheet names a disk path only to a file @hackersandwizards/brand exports (node_modules/@hackersandwizards/brand/fonts/inter.woff2)",
      "[check-coupling] src/fonts.css: not in the exports of @hackersandwizards/brand (@hackersandwizards/brand/tokens.css)",
      "[check-coupling] src/named.css: not in the exports of @hackersandwizards/brand (@hackersandwizards/brand/tokens/tokens.css)",
      "[check-coupling] src/shell.ts: the catalog shell's styles load only under catalog/ (@hackersandwizards/scaffolding/catalog/catalog.css)",
    ]);
  });

  test("code reaches an installed company package through exports or bin, not a disk path", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        name: "@hackersandwizards/fx",
        scripts: { postinstall: "cp node_modules/@hackersandwizards/brand/logos/w.svg public/" },
        scaffolding: {
          allow: [
            {
              check: "coupling",
              path: "scripts/installed.ts",
              text: "node_modules/@hackersandwizards/",
              reason: "lists what bun installed",
            },
          ],
        },
      }),
      "src/logos.ts":
        "export const logo = (f: string) => `node_modules/@hackersandwizards/brand/clients/${f}`;\n",
      "src/root.ts": 'export const brand = join(root, "node_modules/@hackersandwizards/brand");\n',
      "test/story.test.ts":
        'const engine = join(ROOT, "node_modules/@hackersandwizards/slides");\n',
      "src/Page.astro": '<img src="../node_modules/@hackersandwizards/brand/logos/mark.svg" />\n',
      "src/bin.ts": 'export const server = "node_modules/.bin/mcp-fathom-server";\n',
      "src/comment.ts":
        "// node_modules/@hackersandwizards/brand\nconst a = 1; // node_modules/@hackersandwizards/brand\n/*\n  node_modules/@hackersandwizards/brand\n*/\nconst url = 'https://x.dev/a';\n",
      "src/Comment.astro":
        "<!-- node_modules/@hackersandwizards/brand -->\n{/* node_modules/@hackersandwizards/brand */}\n",
      "src/after-source.ts":
        'export const q = "node_modules/@hackersandwizards/brand/x.svg"; // @source\n',
      "src/regex.ts":
        'export const f = (p: string) => p.replace(/^\\/c\\//, "node_modules/@hackersandwizards/brand/c/");\n',
      "src/segments.ts":
        'export const dir = join(root, "node_modules", "@hackersandwizards", "brand");\n',
      "src/tailwind.ts":
        'export const css = `@source "../node_modules/@hackersandwizards/brand/elements";`;\n',
      "src/self.ts": 'export const own = "node_modules/@hackersandwizards/fx/x.svg";\n',
      "src/styles.css": '@source "../node_modules/@hackersandwizards/brand/elements";\n',
      "tools/fonts.py":
        '# node_modules/@hackersandwizards/brand\ndef f():\n    """Reads node_modules/@hackersandwizards/brand."""\nCMD = [\n    """node_modules/@hackersandwizards/brand/data""",\n]\nBRAND = \'node_modules/@hackersandwizards/brand/tokens/fonts\'\nLOGOS = ROOT / \'node_modules\' / \'@hackersandwizards\' / \'brand\' / \'logos\'\nMARKS = Path("node_modules") / "@hackersandwizards"\n',
      "scripts/installed.ts": 'const dir = "node_modules/@hackersandwizards/";\n',
      "src/scope.ts": 'export const at = (n: string) => "node_modules/@hackersandwizards/" + n;\n',
      "og/template.html":
        '<!-- node_modules/@hackersandwizards/brand -->\n<link rel="stylesheet" href="../node_modules/@hackersandwizards/brand/tokens/fonts.css" />\n<style>@font-face { src: url("../node_modules/@hackersandwizards/brand/tokens/fonts/inter.woff2"); }</style>\n<img src="../node_modules/@hackersandwizards/brand/logos/lockup.svg" />\n',
      "mails/brief.json":
        '{ "src": "../node_modules/@hackersandwizards/brand/logos/avatar.png", "url": "https://x.dev/a" }\n',
      "mails/served.json": '{ "src": "../@hackersandwizards/brand/logos/avatar.png" }\n',
      "scripts/fonts.sh":
        "# node_modules/@hackersandwizards/brand\ncp node_modules/@hackersandwizards/brand/tokens/fonts/x.woff2 out/ # copy\n",
      ".github/workflows/ci.yml": "# node_modules/@hackersandwizards/brand\non: push\n",
      "docs/notes.md": "node_modules/@hackersandwizards/brand/logos\n",
    });
    expect(lines(run(dir, "check-coupling").out, "check-coupling").sort()).toEqual([
      `[check-coupling] mails/brief.json: ${installed} (node_modules/@hackersandwizards/brand/logos/avatar.png)`,
      `[check-coupling] og/template.html: ${installed} (node_modules/@hackersandwizards/brand/logos/lockup.svg)`,
      `[check-coupling] og/template.html: ${installed} (node_modules/@hackersandwizards/brand/tokens/fonts.css)`,
      `[check-coupling] og/template.html: ${installed} (node_modules/@hackersandwizards/brand/tokens/fonts/inter.woff2)`,
      `[check-coupling] package.json: ${installed} (node_modules/@hackersandwizards/brand/logos/w.svg)`,
      `[check-coupling] scripts/fonts.sh: ${installed} (node_modules/@hackersandwizards/brand/tokens/fonts/x.woff2)`,
      `[check-coupling] src/Page.astro: ${installed} (node_modules/@hackersandwizards/brand/logos/mark.svg)`,
      `[check-coupling] src/after-source.ts: ${installed} (node_modules/@hackersandwizards/brand/x.svg)`,
      `[check-coupling] src/logos.ts: ${installed} (node_modules/@hackersandwizards/brand/clients/)`,
      `[check-coupling] src/regex.ts: ${installed} (node_modules/@hackersandwizards/brand/c/)`,
      `[check-coupling] src/root.ts: ${installed} (node_modules/@hackersandwizards/brand)`,
      `[check-coupling] src/scope.ts: ${installed} (node_modules/@hackersandwizards/)`,
      `[check-coupling] src/segments.ts: ${installed} (node_modules", "@hackersandwizards)`,
      `[check-coupling] test/story.test.ts: ${installed} (node_modules/@hackersandwizards/slides)`,
      `[check-coupling] tools/fonts.py: ${installed} (node_modules") / "@hackersandwizards)`,
      `[check-coupling] tools/fonts.py: ${installed} (node_modules' / '@hackersandwizards)`,
      `[check-coupling] tools/fonts.py: ${installed} (node_modules/@hackersandwizards/brand/data)`,
      `[check-coupling] tools/fonts.py: ${installed} (node_modules/@hackersandwizards/brand/tokens/fonts)`,
    ]);
  });

  test("a package of ours without our scope is ours by its repository's owner", () => {
    const pin = (owner: string, name: string) =>
      `git+https://github.com/${owner}/${name}.git#v1.0.0`;
    const dir = repo({
      "package.json": JSON.stringify({
        name: "fx",
        dependencies: {
          practitioners: pin("hackersandwizards", "practitioners"),
          lodash: pin("lodash", "lodash"),
        },
      }),
      "node_modules/practitioners/package.json": JSON.stringify({
        name: "practitioners",
        version: "1.0.0",
        exports: { "./schema": "./src/lib/schema.ts" },
      }),
      "node_modules/lodash/package.json": JSON.stringify({ name: "lodash", version: "1.0.0" }),
      "src/schema.ts": 'export const s = "node_modules/practitioners/src/lib/schema.ts";\n',
      "src/segments.ts": 'export const d = join(root, "node_modules", "practitioners");\n',
      "src/other.ts": 'export const o = "node_modules/lodash/lodash.js";\n',
    });
    expect(lines(run(dir, "check-coupling").out, "check-coupling").sort()).toEqual([
      `[check-coupling] src/schema.ts: ${installed} (node_modules/practitioners/src/lib/schema.ts)`,
      `[check-coupling] src/segments.ts: ${installed} (node_modules", "practitioners)`,
    ]);
  });

  test("a climb after a prefix, a home path into another checkout and a mark in a string count", () => {
    const home = temp();
    mkdirSync(join(home, "dev/org"), { recursive: true });
    const other = join(home, "dev/org/other");
    sh(home, ["init", "-q", other]);
    // dev/org/gone is cloned nowhere: the finding stays the same on every machine.
    const dir = join(home, "dev/org/this");
    renameSync(
      repo({
        "package.json": JSON.stringify({ name: "this" }),
        ".githooks/pre-commit": '#!/bin/sh\ncd "$ROOT/../other"\ncd "$(dirname "$0")/../src"\n',
        "src/a.ts":
          'const a = `${root}/../../other/x.css`;\nconst b = "./../../../other/x.css";\nconst c = "x//y", d = "node_modules/@hackersandwizards/brand/x.ts";\n',
        "src/b.ts":
          'const k = `${process.env.HOME}/dev/org/other/secrets.zsh`;\nconst g = "~/dev/org/gone/x.ts";\nconst own = "~/dev/org/this/src/a.ts";\nconst c = "~/.config/x"; // node_modules/@hackersandwizards/brand/note\nconst e = "it\'s"; // node_modules/@hackersandwizards/brand/note\n',
      }),
      dir,
    );
    expect(
      lines(run(dir, "check-coupling", [], { HOME: home }).out, "check-coupling")
        .map((l) => l.replace(/: .*\(/, " ("))
        .sort(),
    ).toEqual([
      "[check-coupling] .githooks/pre-commit ($ROOT/../other)",
      "[check-coupling] src/a.ts (${root}/../../other/x.css)",
      "[check-coupling] src/a.ts (./../../../other/x.css)",
      "[check-coupling] src/a.ts (node_modules/@hackersandwizards/brand/x.ts)",
      "[check-coupling] src/b.ts (${process.env.HOME}/dev/org/other/secrets.zsh)",
      "[check-coupling] src/b.ts (~/dev/org/gone/x.ts)",
    ]);
  });

  test("a linked worktree outside the dev root judges home paths by its repository's dev root", () => {
    const home = temp();
    mkdirSync(join(home, "dev/org"), { recursive: true });
    const dir = join(home, "dev/org/this");
    renameSync(
      repo({
        "package.json": JSON.stringify({ name: "this" }),
        "run.sh":
          'cd ../other\nscratch="$HOME/Library/Caches/claude-code-tmp/$name/"\nlog=~/Library/Caches/claude-code-tmp/x.log\nown=~/dev/org/this/src\nother=~/dev/org/other/x\n',
      }),
      dir,
    );
    const wt = join(home, "Library/Caches/claude-code-tmp/run/wt");
    sh(dir, ["worktree", "add", "-q", "--detach", wt]);
    expect(
      lines(run(wt, "check-coupling", [], { HOME: home }).out, "check-coupling")
        .map((l) => l.replace(/: .*\(/, " ("))
        .sort(),
    ).toEqual([
      "[check-coupling] run.sh (../other)",
      "[check-coupling] run.sh (~/dev/org/other/x)",
    ]);
  });

  test("a comment touching the code is no path, and a glob in a string hides none", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "fx" }),
      "src/a.css": "a{b:c;}/* node_modules/@hackersandwizards/brand/x.woff2 */\n",
      "src/b.ts":
        'const g = "src/*.ts";\nconst p = "node_modules/@hackersandwizards/brand/x.svg"; // */\n',
    });
    expect(lines(run(dir, "check-coupling").out, "check-coupling")).toEqual([
      `[check-coupling] src/b.ts: ${installed} (node_modules/@hackersandwizards/brand/x.svg)`,
    ]);
  });

  test("an allow entry needs a reason and must still match", () => {
    const allow = (entries: object[]) =>
      repo({
        "package.json": JSON.stringify({ scaffolding: { allow: entries } }),
        "src/a.ts": 'import "../../x";\n',
      });
    // Its text names the path it excuses, and package.json is not flagged for it.
    const reasoned = { check: "coupling", path: "src/*.ts", text: "../../x", reason: "test" };
    expect(run(allow([reasoned]), "check-coupling").code).toBe(0);
    for (const reason of ["", true])
      expect(run(allow([{ ...reasoned, reason }]), "check-coupling").out).toContain(
        "allow entry without a reason",
      );
    const stale = allow([reasoned, { check: "coupling", path: "src/gone.ts", reason: "old" }]);
    expect(run(stale, "check-coupling").out).toContain("allow entry matches nothing");
  });
});

// What `bun install` would leave: this package under node_modules, so the shared configs resolve.
function install(dir: string) {
  mkdirSync(join(dir, "node_modules/@hackersandwizards"), { recursive: true });
  symlinkSync(
    join(import.meta.dirname, ".."),
    join(dir, "node_modules/@hackersandwizards/scaffolding"),
  );
}

// Local stand-ins for the company remotes scaffold reads brand's and admin's newest tag from.
function remotes(tags: string[]) {
  const base = temp();
  for (const name of ["brand", "admin"]) {
    const dir = join(base, `${name}.git`);
    mkdirSync(dir);
    sh(dir, ["init", "-q", "-b", "main"]);
    sh(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
    for (const tag of tags) sh(dir, ["tag", tag]);
  }
  return `${base}/`;
}
process.env.SCAFFOLDING_GIT_BASE = remotes(["v0.9.0", "v0.10.0", "v0.2.0", "latest"]);
const ownVersion = ownPackage.version;
// A decodable 1x1 PNG: OCR reads it and finds no text.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
// Run from its own checkout, the package pins its HEAD.
const ownHead = sh(join(import.meta.dirname, ".."), ["rev-parse", "HEAD"])
  .stdout.toString()
  .trim();

test("check-structure: a bin file is stored executable, and --fix makes it so", () => {
  const dir = repo({
    "package.json": JSON.stringify({ bin: { x: "./bin/x.ts", y: "bin/y.ts" } }),
    "bin/x.ts": "#!/usr/bin/env bun\n",
    "bin/y.ts": "#!/usr/bin/env bun\n",
    "bin/z.ts": "export {};\n",
  });
  chmodSync(join(dir, "bin/y.ts"), 0o755);
  sh(dir, ["update-index", "--chmod=+x", "bin/y.ts"]);
  const binLines = (args: string[] = []) =>
    lines(run(dir, "check-structure", args).out, "check-structure").filter((l) =>
      l.includes("bin file"),
    );
  expect(binLines()).toEqual([
    "[check-structure] bin/x.ts: a bin file is stored executable (check-structure --fix) (100644)",
  ]);
  run(dir, "check-structure", ["--fix"]);
  expect(binLines()).toEqual([]);
  expect(sh(dir, ["ls-files", "-s", "bin/x.ts"]).stdout.toString().startsWith("100755")).toBe(true);
  // --fix stages the mode alone, never an uncommitted edit.
  sh(dir, ["update-index", "--chmod=-x", "bin/x.ts"]);
  writeFileSync(join(dir, "bin/x.ts"), "#!/usr/bin/env bun\nedited;\n");
  run(dir, "check-structure", ["--fix"]);
  expect(
    sh(dir, ["ls-files", "-s", "bin/x.ts"])
      .stdout.toString()
      .startsWith(`100755 ${sh(dir, ["rev-parse", "HEAD:bin/x.ts"]).stdout.toString().trim()} `),
  ).toBe(true);
});

test("check-structure: a hook with the skeleton's bytes but no executable bit fails, and --fix sets it", () => {
  const dir = repo({ "package.json": "{}" });
  run(dir, "check-structure", ["--fix"]);
  sh(dir, ["add", "-A"]);
  const hookLines = () =>
    lines(run(dir, "check-structure").out, "check-structure").filter((l) => l.includes("a hook"));
  expect(hookLines()).toEqual([]);
  chmodSync(join(dir, ".githooks/pre-commit"), 0o644);
  sh(dir, ["update-index", "--chmod=-x", ".githooks/post-merge"]);
  expect(hookLines()).toEqual([
    "[check-structure] .githooks/pre-commit: a hook is executable (check-structure --fix) (100755)",
    "[check-structure] .githooks/post-merge: a hook is executable (check-structure --fix) (100644)",
  ]);
  run(dir, "check-structure", ["--fix"]);
  expect(hookLines()).toEqual([]);
  expect(
    sh(dir, ["ls-files", "-s", ".githooks/post-merge"]).stdout.toString().startsWith("100755"),
  ).toBe(true);
});

test("every bin target and every file in bin/ is stored executable, wherever the target lives", () => {
  const root = join(import.meta.dirname, "..");
  const { bin } = ownPackage;
  const stored = new Map(
    sh(root, ["ls-files", "-s", "--", "bin", ...Object.values(bin), "README.md"])
      .stdout.toString()
      .trim()
      .split("\n")
      .map((line) => {
        const [entry, path] = line.split("\t");
        return [path, entry.split(" ")[0]];
      }),
  );
  // Control: the same read of a file stored plain has to answer 100644.
  expect(stored.get("README.md")).toBe("100644");
  stored.delete("README.md");
  expect(Object.values(bin).filter((path) => !stored.has(path))).toEqual([]);
  // No `env -S`: BusyBox `env`, as on Alpine, refuses it.
  for (const path of Object.values(bin))
    expect([path, readFileSync(join(root, path), "utf8").split("\n").slice(0, 2)]).toEqual([
      path,
      ["#!/bin/sh", '// 2>/dev/null; exec bun --no-env-file "$0" "$@"'],
    ]);
  expect([...stored].filter(([, mode]) => mode !== "100755")).toEqual([]);
});

test("a tag install, GitHub's archive of the tag, holds what files names, template's dotfiles too", () => {
  const root = join(import.meta.dirname, "..");
  const shipped = ["package.json", "README.md", "LICENSE", ...ownPackage.files];
  const committed = sh(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", ...shipped])
    .stdout.toString()
    .split("\n")
    .filter(Boolean);
  const archived = spawnSync("sh", ["-c", "git archive --worktree-attributes HEAD | tar -t"], {
    cwd: root,
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter((path) => path && !path.endsWith("/"));
  expect(archived).toContain("template/.npmrc");
  expect(archived.sort()).toEqual(committed.sort());
});

/** A scaffolded repository's package.json, with every section `scaffold` writes present. */
function scaffolded(dir: string) {
  const pkg = readPackage(dir);
  const { scripts, devDependencies, engines, scaffolding } = pkg;
  if (!scripts || !devDependencies || !engines || !scaffolding?.skip || !scaffolding.check)
    throw new Error(`${dir}/package.json lacks a section scaffold writes`);
  const { skip, check } = scaffolding;
  return {
    ...pkg,
    scripts,
    devDependencies,
    engines,
    scaffolding: { ...scaffolding, skip, check },
  };
}

describe("scaffold and check-structure", () => {
  const parent = temp();
  const dir = join(parent, "demo");
  const made = run(parent, "scaffold", ["demo", "--port", "4655"]);
  install(dir);
  write(dir, { "bun.lock": "" });
  sh(dir, ["config", "core.hooksPath", ".githooks"]);
  const hooksPath = (root: string) =>
    sh(root, ["config", "--local", "core.hooksPath"]).stdout.toString().trim();
  const fixture = (
    name: string,
    config: Record<string, unknown>,
    files: Record<string, string> = {},
    gone: string[] = [],
  ) => {
    const other = join(parent, name);
    cpSync(dir, other, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) => !path.endsWith("/node_modules"),
    });
    const pkg = scaffolded(other);
    Object.assign(pkg.scaffolding, config);
    write(other, { "package.json": JSON.stringify(pkg, null, 2), ...files });
    for (const path of gone) rmSync(join(other, path));
    install(other);
    return other;
  };

  test("a scaffolded repository passes", () => {
    expect(made.code).toBe(0);
    const pkg = scaffolded(dir);
    expect(pkg.name).toBe("demo");
    // The bun floor and prepare script come from this package.
    expect(pkg.engines?.bun).toBe(ownPackage.engines.bun);
    expect(pkg.scripts?.prepare).toBe(ownPackage.scripts.prepare);
    expect(pkg.scripts?.fix).toBeUndefined();
    // Every placeholder filled and every .tmpl renamed, in whichever template file it sits.
    const files = sh(dir, ["ls-files", "-co", "--exclude-standard"]).stdout.toString().split("\n");
    expect(files.filter((f) => f.endsWith(".tmpl"))).toEqual([]);
    expect(
      files.filter(
        (f) =>
          statSync(join(dir, f), { throwIfNoEntry: false })?.isFile() &&
          /\{\{\w+\}\}/.test(readFileSync(join(dir, f), "utf8")),
      ),
    ).toEqual([]);
    const r = run(dir, "check-structure");
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  });

  test("the shared oxlint config is required and --fix preserves a local layer policy", () => {
    const name = ".oxlintrc.json";
    const other = fixture("oxlint-structure", {}, {}, [name]);
    expect(run(other, "check-structure").out).toContain(`${name}: missing`);
    expect(run(other, "check-structure", ["--fix"]).code).toBe(0);
    const config = { ...oxlintTemplate, rules: { "no-restricted-imports": ["error", "blocked"] } };
    write(other, { [name]: JSON.stringify(config) });
    expect(run(other, "check-structure", ["--fix"]).code).toBe(0);
    expect(jsonObject(readFileSync(join(other, name))).rules).toEqual(config.rules);
    for (const broken of [
      { extends: [] },
      { options: { typeAware: false } },
      { ignorePatterns: [] },
    ]) {
      write(other, { [name]: JSON.stringify({ ...config, ...broken }) });
      const result = run(other, "check-structure");
      expect(result.code).toBe(1);
      expect(result.out).toContain(`${name}: ${Object.keys(broken)[0]}`);
    }
  });

  test(
    "the effective lint presets are disjoint and check-structure rejects local overlaps",
    () => {
      const config = 'import base from "@hackersandwizards/scaffolding/eslint/astro";\n';
      const eslint = "eslint.config.js";
      const oxlint = ".oxlintrc.json";
      const other = fixture(
        "lint-ownership",
        {},
        {
          [eslint]: config + "export default base;\n",
          "src/probe.js": "export const js = true;\n",
          "src/probe.ts": "export const ts = true;\n",
          "src/probe.test.ts": "export const test = true;\n",
          "src/Data.astro": '<script type="text/plain">text</script>\n',
          "src/Probe.astro":
            "---\nconst value = 1;\n---\n{value}\n<script>console.log(1);</script>\n",
        },
      );
      expect(run(other, "check-structure")).toEqual({ code: 0, out: "" });

      write(other, {
        [eslint]:
          config +
          `export default [...base,
        { files: ["src/probe.js", "src/*.astro/*.ts"], rules: { "no-debugger": "warn" } },
        { files: ["src/probe.ts"], rules: { "@typescript-eslint/no-floating-promises": "error" } },
        { files: ["src/probe.test.ts"], rules: { "@typescript-eslint/no-unused-vars": "error" } },
      ];\n`,
      });
      const localEslint = run(other, "check-structure");
      expect(localEslint.code).toBe(1);
      expect(lines(localEslint.out, "check-structure")).toEqual([
        expect.stringMatching(
          /src\/Probe\.astro\/\S+\.ts: ESLint rule no-debugger overlaps Oxlint rule no-debugger.*\(Astro client script\)/,
        ),
        expect.stringContaining(
          "src/probe.js: ESLint rule no-debugger overlaps Oxlint rule no-debugger",
        ),
        expect.stringContaining(
          "src/probe.test.ts: ESLint rule @typescript-eslint/no-unused-vars overlaps Oxlint rule no-unused-vars",
        ),
        expect.stringContaining(
          "src/probe.ts: ESLint rule @typescript-eslint/no-floating-promises overlaps Oxlint rule typescript/no-floating-promises",
        ),
      ]);
      write(other, { [eslint]: config + "export default base;\n" });
      expect(run(other, "check-structure")).toEqual({ code: 0, out: "" });

      write(other, {
        [eslint]:
          config +
          'export default [...base, { files: ["src/Probe.astro/*_frontmatter.tsx"], rules: { "no-debugger": "error" } }];\n',
      });
      const frontmatterOverlap = run(other, "check-structure");
      expect(frontmatterOverlap.code).toBe(1);
      expect(lines(frontmatterOverlap.out, "check-structure")).toEqual([
        expect.stringMatching(
          /src\/Probe\.astro\/\d+_frontmatter\.tsx: ESLint rule no-debugger overlaps Oxlint rule no-debugger.*\(Astro frontmatter\)/,
        ),
      ]);
      write(other, { [eslint]: config + "export default base;\n" });

      write(other, {
        [oxlint]: JSON.stringify({
          ...oxlintTemplate,
          overrides: [{ files: ["src/*.astro"], rules: { "eslint/no-undef": "warn" } }],
        }),
      });
      const localOxlint = run(other, "check-structure");
      expect(localOxlint.code).toBe(1);
      expect(lines(localOxlint.out, "check-structure")).toEqual([
        expect.stringContaining(
          "src/Probe.astro: ESLint rule no-undef overlaps Oxlint rule no-undef",
        ),
        expect.stringMatching(
          /src\/Probe\.astro\/\S+\.ts: ESLint rule no-undef overlaps Oxlint rule no-undef/,
        ),
      ]);
      write(other, { [oxlint]: JSON.stringify(oxlintTemplate) });
      expect(run(other, "check-structure")).toEqual({ code: 0, out: "" });
    },
    limit(10_000),
  );

  test("a full repository has its catalog, brand and admin on their newest tags", () => {
    const pkg = scaffolded(dir);
    expect(pkg.devDependencies["@hackersandwizards/brand"]).toBe(
      "git+https://github.com/hackersandwizards/brand.git#v0.10.0",
    );
    expect(pkg.devDependencies["@hackersandwizards/admin"]).toBe(
      "git+https://github.com/hackersandwizards/admin.git#v0.10.0",
    );
    expect(pkg.scaffolding.skip).toEqual({
      test: "new repository: no tests yet",
      elements: "the starter catalog declares no brand element pages",
    });
    expect(pkg.scripts.build).toBe("check-lock bun --bun astro build --root catalog");
    expect(pkg.scripts["check:retired"]).toBeUndefined();
    expect(pkg.scaffolding.brand).toEqual({ retired: ["dist"] });
    // Under an agent `astro preview` moves into the background, which resolves --root catalog from
    // inside catalog/ and finds no catalog/catalog/dist.
    expect(pkg.scripts.preview).toBe(PREVIEW);
    const config = readFileSync(join(dir, "catalog/astro.config.ts"), "utf8");
    expect(config).toContain('base: "/demo"');
    expect(config).toContain('site: "https://hackersandwizards.github.io"');
    expect(config).toContain("port: 4655 }");
    // The catalog's .astro files are linted by the Astro config, with its plugin pinned.
    expect(
      readFileSync(join(dir, "eslint.config.js"), "utf8").startsWith(
        'export { default } from "@hackersandwizards/scaffolding/eslint/astro";',
      ),
    ).toBe(true);
    expect(pkg.devDependencies["eslint-plugin-astro"]).toBe(
      ownPackage.devDependencies["eslint-plugin-astro"],
    );
    expect(readFileSync(join(dir, ".github/workflows/pages.yml"), "utf8")).toContain(
      `uses: hackersandwizards/scaffolding/.github/workflows/pages.yml@${ownHead} # v${ownVersion}\n`,
    );
    // No placeholder item: the hub would list it as the repository's open goal.
    expect(readdirSync(join(dir, "docs/agent-work"))).toEqual([".gitkeep"]);
    expect(readFileSync(join(dir, "tsconfig.json"), "utf8")).toContain('"catalog/**/*.ts"]');
    const prettier = join(import.meta.dirname, "..", "node_modules", ".bin", "prettier");
    const formatted = spawnSync(prettier, ["--check", "."], { cwd: dir, encoding: "utf8" });
    expect(`${formatted.stdout}${formatted.stderr}`).toContain("All matched files use Prettier");
    expect(formatted.status).toBe(0);
  });

  test("--name: a scope stays out of the Pages path and the title, a bad name writes nothing", () => {
    const at = temp();
    expect(run(at, "scaffold", ["scoped", "--name", "@acme/scoped"]).code).toBe(0);
    const config = readFileSync(join(at, "scoped/catalog/astro.config.ts"), "utf8");
    expect(config).toContain('base: "/scoped"');
    expect(config).toContain('product: "scoped"');
    expect(readFileSync(join(at, "scoped/README.md"), "utf8").startsWith("# scoped\n")).toBe(true);
    expect(readPackage(join(at, "scoped")).name).toBe("@acme/scoped");
    const next = [
      "Next, in the terminal: cd inner && bun install && bun run check",
      "[scaffold] Then by hand:",
      "[scaffold]   1. add inner to the hub's sync list",
      "[scaffold]   2. create hackersandwizards/inner on GitHub and push to it\n",
    ].join("\n");
    expect(run(at, "scaffold", ["inner", "--catalog-in", "x"]).out.endsWith(next)).toBe(true);
    for (const name of ['a"b', "Upper"]) {
      const bad = run(at, "scaffold", ["bad", "--name", name]);
      expect(bad.out).toContain("is no npm package name");
      expect(existsSync(join(at, "bad"))).toBe(false);
    }
  });

  test("the skeleton has no preinstall, and its prepare sets the hooks path at the top level only", () => {
    const other = fixture("prepare", {});
    const { scripts } = scaffolded(other);
    expect(scripts.preinstall).toBeUndefined();
    const prepare = (cwd: string) => spawnSync("sh", ["-c", scripts.prepare], { cwd });
    sh(other, ["config", "--unset", "core.hooksPath"]);
    // In a folder that is no repository's top level, as a dependency's is, it does nothing.
    expect(prepare(join(other, ".githooks")).status).toBe(0);
    expect(hooksPath(other)).toBe("");
    expect(prepare(other).status).toBe(0);
    expect(hooksPath(other)).toBe(".githooks");
  });

  test("--catalog-in and --admin-in leave both out and the skips name where they live", () => {
    const minimal = join(parent, "minimal");
    const r = run(
      parent,
      "scaffold",
      ["minimal", "--catalog-in", "acme-private", "--admin-in", "acme-private"],
      {
        SCAFFOLDING_GIT_BASE: "/nonexistent/",
      },
    );
    expect(r.code).toBe(0);
    install(minimal);
    write(minimal, { "bun.lock": "" });
    sh(minimal, ["config", "core.hooksPath", ".githooks"]);
    const pkg = scaffolded(minimal);
    expect(
      Object.keys(pkg.devDependencies).filter((d) => d.startsWith("@hackersandwizards/")),
    ).toEqual(["@hackersandwizards/scaffolding"]);
    expect(pkg.scaffolding.check).toEqual([]);
    expect(pkg.scripts["check:retired"]).toBeUndefined();
    expect(pkg.scaffolding.skip).toEqual({
      test: "new repository: no tests yet",
      catalog: "the catalog lives in acme-private",
      styles: "the catalog lives in acme-private",
      admin: "the admin area lives in acme-private",
    });
    const top = readdirSync(minimal);
    for (const path of ["catalog", ".github", "stylelint.config.js"])
      expect(top).not.toContain(path);
    expect(readdirSync(join(minimal, "docs/agent-work"))).toEqual([".gitkeep"]);
    expect(run(minimal, "check-structure").code).toBe(0);
  });

  test("a remote without a version tag fails scaffold", () => {
    const r = run(parent, "scaffold", ["untagged"], { SCAFFOLDING_GIT_BASE: remotes(["latest"]) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("no v<version> tag read from");
  });

  test("the owned Pages workflow: an edit goes red, --fix writes this version, absence passes", () => {
    const path = join(dir, ".github/workflows/pages.yml");
    const original = readFileSync(path, "utf8");
    write(dir, {
      ".github/workflows/pages.yml": original.replace(`@${ownHead}`, `@v${ownVersion}`),
    });
    expect(lines(run(dir, "check-structure").out, "check-structure")).toEqual([
      "[check-structure] .github/workflows/pages.yml: differs from the skeleton (check-structure --fix)",
    ]);
    run(dir, "check-structure", ["--fix"]);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(run(dir, "check-structure").code).toBe(0);
    rmSync(path);
    expect(run(dir, "check-structure").code).toBe(0);
    write(dir, { ".github/workflows/pages.yml": original });
  });

  test("the Pages pin: bun's short SHA offline, the tag's full commit from the remote, a moved tag refused", () => {
    const home = temp();
    write(home, { ".bun-tag": "hackersandwizards-scaffolding-0123abc\n" });
    expect(installedCommit(home)).toBe("0123abc");
    // A dependency bun clones rather than fetches as a tarball: the bare SHA.
    write(home, { ".bun-tag": `${"a".repeat(40)}\n` });
    expect(installedCommit(home)).toBe("a".repeat(40));
    // An install that is neither a Git dependency nor the package's own checkout has none.
    expect(installedCommit(temp())).toBeUndefined();
    const base = temp();
    const remote = join(base, "scaffolding.git");
    mkdirSync(remote);
    sh(remote, ["init", "-q", "-b", "main"]);
    sh(remote, ["commit", "-q", "--allow-empty", "-m", "init"]);
    // Annotated, so the tag's own object differs from the commit the workflow must name.
    sh(remote, ["tag", "-a", "v9.9.9", "-m", "release"]);
    const full = sh(remote, ["rev-parse", "HEAD"]).stdout.toString().trim();
    const before = process.env.SCAFFOLDING_GIT_BASE;
    process.env.SCAFFOLDING_GIT_BASE = `${base}/`;
    try {
      expect(tagCommit("9.9.9", full.slice(0, 7))).toBe(full);
      expect(() => tagCommit("9.9.9", "0000000")).toThrow("the tag moved");
      expect(() => tagCommit("9.9.8", full.slice(0, 7))).toThrow("v9.9.8 not read from");
    } finally {
      process.env.SCAFFOLDING_GIT_BASE = before;
    }
  });

  test("--fix leaves a file an allow entry keeps", () => {
    const path = ".github/workflows/pages.yml";
    const other = fixture(
      "allow-owned",
      { allow: [{ check: "structure", path, reason: "own workflow" }] },
      { [path]: "custom\n" },
    );
    run(other, "check-structure", ["--fix"]);
    expect(readFileSync(join(other, path), "utf8")).toBe("custom\n");
    expect(run(other, "check-structure").code).toBe(0);
  });

  test("LICENSE is required where the repository is public; a private one may have none", () => {
    const missing = (config: Record<string, unknown>, name: string) =>
      lines(
        run(fixture(name, config, {}, ["LICENSE"]), "check-structure").out,
        "check-structure",
      ).filter((l) => l.includes("LICENSE"));
    expect(missing({}, "public-no-license")).toEqual(["[check-structure] LICENSE: missing"]);
    expect(missing({ private: true }, "private-no-license")).toEqual([]);
  });

  test("the .agents/skills link is required where .claude/skills exists", () => {
    const none = fixture("no-skills", {}, {}, [".agents/skills"]);
    expect(lines(run(none, "check-structure").out, "check-structure")).toEqual([]);
    const skills = fixture("skills", {}, { ".claude/skills/a/SKILL.md": "x\n" }, [
      ".agents/skills",
    ]);
    expect(lines(run(skills, "check-structure").out, "check-structure")).toEqual([
      "[check-structure] .agents/skills: must be a symlink to ../.claude/skills",
    ]);
    run(skills, "check-structure", ["--fix"]);
    expect(run(skills, "check-structure").code).toBe(0);
    // A link that is wrong stays red where .claude/skills is absent too.
    const wrong = fixture("wrong-link", {}, { "keep/x": "x\n" }, [".agents/skills"]);
    symlinkSync("../keep", join(wrong, ".agents/skills"));
    expect(lines(run(wrong, "check-structure").out, "check-structure")).toEqual([
      "[check-structure] .agents/skills: must be a symlink to ../.claude/skills",
    ]);
  });

  test("the skeleton's MCP and SessionStart blocks: a differing one goes red, --fix writes it in", () => {
    const other = fixture(
      "entries",
      {},
      {
        ".mcp.json":
          '{ "mcpServers": { "own": { "command": "x" }, "chrome-devtools": { "command": "old" } } }\n',
        ".claude/settings.json":
          '{ "model": "x", "hooks": { "SessionStart": [{ "matcher": "startup", "hooks": [] }, { "matcher": "resume", "hooks": [] }] } }\n',
      },
    );
    expect(lines(run(other, "check-structure").out, "check-structure")).toEqual([
      "[check-structure] .mcp.json: differs from the skeleton (check-structure --fix) (mcpServers.chrome-devtools)",
      "[check-structure] .claude/settings.json: differs from the skeleton (check-structure --fix) (hooks.SessionStart)",
    ]);
    run(other, "check-structure", ["--fix"]);
    expect(run(other, "check-structure").code).toBe(0);
    const mcp = jsonObject(readFileSync(join(other, ".mcp.json")));
    expect(mcp.mcpServers).toEqual({
      own: { command: "x" },
      "chrome-devtools": templateMcp.mcpServers["chrome-devtools"],
    });
    // The repository's own SessionStart hook stays beside the skeleton's; an older copy of the
    // skeleton's, under its matcher, goes.
    const settings = jsonObject(readFileSync(join(other, ".claude/settings.json")));
    expect(settings).toEqual({
      model: "x",
      hooks: {
        SessionStart: [...templateSettings.hooks.SessionStart, { matcher: "resume", hooks: [] }],
      },
    });
    // A file whose value in the way is no object is a finding, never a crash.
    write(other, { ".claude/settings.json": '{ "hooks": "x" }\n', ".mcp.json": "null\n" });
    expect(lines(run(other, "check-structure", ["--fix"]).out, "check-structure")).toEqual([
      "[check-structure] .mcp.json: mcpServers.chrome-devtools sits in no JSON object",
      "[check-structure] .claude/settings.json: hooks.SessionStart sits in no JSON object",
    ]);
  });

  test("the retired install guard goes red", () => {
    const guard = "scripts/repo/only-bun.cjs";
    const other = fixture("only-bun", {}, { [guard]: "\n" });
    expect(lines(run(other, "check-structure").out, "check-structure")).toEqual([
      `[check-structure] ${guard}: not allowed by the skeleton`,
    ]);
  });

  describe("--fix writes nothing an opt-out covers", () => {
    /** Every path with its mode and content or link target, the index and the hooks path. */
    const state = (root: string) => ({
      seen: (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
        .filter((path) => !/^(\.git|node_modules)(\/|$)/.test(path))
        .sort()
        .map((path) => {
          const stat = lstatSync(join(root, path));
          const body = stat.isSymbolicLink()
            ? readlinkSync(join(root, path))
            : stat.isFile()
              ? readFileSync(join(root, path), "utf8")
              : "";
          return `${path} ${stat.mode} ${body}`;
        }),
      hooks: hooksPath(root),
      index: sh(root, ["ls-files", "-s"]).stdout.toString(),
    });
    const skip = { structure: "custom skeleton files" };

    test("skip.structure with a custom hook, missing files and a stale hooks path and mode", () => {
      const other = fixture(
        "skip-public",
        { skip },
        {
          ".githooks/pre-commit": "#!/bin/sh\ncustom\n",
          "bin/x.ts": "export {};\n",
          ".claude/skills/a/SKILL.md": "x\n",
        },
        [
          ".editorconfig",
          ".npmrc",
          "bunfig.toml",
          ".githooks/commit-msg",
          ".githooks/post-merge",
          ".agents/skills",
        ],
      );
      const pkg = scaffolded(other);
      write(other, { "package.json": JSON.stringify({ ...pkg, bin: { x: "bin/x.ts" } }) });
      sh(other, ["config", "--unset", "core.hooksPath"]);
      sh(other, ["add", "bin/x.ts"]);
      const before = state(other);
      expect(run(other, "check-structure").code).toBe(1);
      const fixed = run(other, "check-structure", ["--fix"]);
      expect(fixed.code).toBe(0);
      expect(fixed.out).toContain("--fix writes nothing: scaffolding.skip.structure");
      expect(state(other)).toEqual(before);
    });

    for (const [shape, reason] of [
      ["with a reason", "custom skeleton files"],
      ["without a reason", ""],
    ])
      test(`skip.structure ${shape} keeps a private repository's commit-msg and older hook`, () => {
        const other = fixture(
          `skip-private-${reason ? "reason" : "blank"}`,
          { skip: { structure: reason }, private: true },
          { ".githooks/post-checkout": "#!/bin/sh\nolder\n", ".claude/skills/a/SKILL.md": "x\n" },
          ["bunfig.toml", ".agents/skills"],
        );
        const before = state(other);
        expect(run(other, "check-structure", ["--fix"]).code).toBe(0);
        expect(state(other)).toEqual(before);
      });

    for (const [shape, path] of [
      ["one path", ".githooks/pre-push"],
      ["a glob", ".githooks/pre-p*"],
      ["a list", [".githooks/pre-push", "bunfig.toml"]],
    ] as const)
      test(`an allow entry naming ${shape} keeps the file and --fix still repairs the rest`, () => {
        const other = fixture(
          `allow-${shape.replace(" ", "-")}`,
          { private: true, allow: [{ check: "structure", path, reason: "own hook" }] },
          { ".githooks/pre-push": "#!/bin/sh\ncustom\n", ".editorconfig": "root = true\n" },
          ["bunfig.toml"],
        );
        run(other, "check-structure", ["--fix"]);
        expect(readFileSync(join(other, ".githooks/pre-push"), "utf8")).toBe("#!/bin/sh\ncustom\n");
        expect(existsSync(join(other, "bunfig.toml"))).toBe(!Array.isArray(path));
        expect(readFileSync(join(other, ".editorconfig"), "utf8")).not.toBe("root = true\n");
        expect(existsSync(join(other, ".githooks/commit-msg"))).toBe(false);
      });
  });

  test("a drifted file goes red and --fix restores it", () => {
    write(dir, { ".editorconfig": "root = true\n" });
    expect(run(dir, "check-structure").out).toContain(".editorconfig: differs from the skeleton");
    run(dir, "check-structure", ["--fix"]);
    expect(run(dir, "check-structure").code).toBe(0);
  });

  test("a forbidden file, a wrong width and the hooks path go red", () => {
    const other = join(parent, "other");
    run(parent, "scaffold", ["other"]);
    install(other);
    const { prettier: _prettier, ...pkg } = readPackage(other);
    write(other, {
      "package.json": JSON.stringify(pkg),
      "bun.lock": "",
      "eslint.config.mjs": "",
      ".prettierrc.json": JSON.stringify({
        semi: true,
        singleQuote: false,
        trailingComma: "all",
        printWidth: 80,
      }),
    });
    const out = run(other, "check-structure").out;
    expect(out).toContain("eslint.config.mjs: not allowed by the skeleton");
    expect(out).toContain("printWidth must be 100");
    expect(out).toContain("core.hooksPath must be .githooks");
  });

  describe("Stryker repositories run mutation testing through the capped wrapper", () => {
    const red = {
      code: 1,
      findings: [
        '[check-structure] package.json: set scripts.mutation to "mutation": "scaffolding-mutation"',
      ],
    };
    const green = { code: 0, findings: [] };
    test.each([
      { name: "allows no mutation script without Stryker", expected: green },
      { name: "requires the wrapper with the Stryker dependency", dependency: true, expected: red },
      { name: "rejects running Stryker directly", mutation: "stryker run", expected: red },
      { name: "rejects echoing the wrapper", mutation: "echo scaffolding-mutation", expected: red },
      {
        name: "rejects naming the wrapper in an environment variable",
        mutation: "FLAG='scaffolding-mutation' bun run stryker run",
        expected: red,
      },
      { name: "accepts the wrapper", mutation: "scaffolding-mutation", expected: green },
      {
        name: "accepts the wrapper with an environment variable and Bun flags",
        mutation: "BUN_OPTIONS='--preload vitest/node' bun --bun scaffolding-mutation",
        expected: green,
      },
    ])("$name", ({ name, dependency, mutation, expected }) => {
      const other = fixture(
        `mutation-wrapper ${name}`,
        {},
        mutation === undefined ? {} : { "stryker.config.mjs": "export default {};\n" },
      );
      const pkg = scaffolded(other);
      write(other, {
        "package.json": JSON.stringify({
          ...pkg,
          devDependencies: dependency
            ? { ...pkg.devDependencies, "@stryker-mutator/core": "10.1.1" }
            : pkg.devDependencies,
          scripts: { ...pkg.scripts, mutation },
        }),
      });
      const { code, out } = run(other, "check-structure");
      expect({ code, findings: lines(out, "check-structure") }).toEqual(expected);
    });
  });

  test("Stryker mutate entries cover whole files instead of line ranges", () => {
    const path = "stryker.config.mjs";
    const other = fixture(
      "mutation-scope",
      {},
      {
        [path]: `import base from "@hackersandwizards/scaffolding/stryker";
export default {
  ...base,
  mutate: ["src/{first,second}.ts", "lib/deck-edit.ts"],
  ignorePatterns: ["example.ts:15-217"],
};
// mutate: ["commented.ts:15-217"]`,
      },
    );
    const pkg = scaffolded(other);
    write(other, {
      "package.json": JSON.stringify({
        ...pkg,
        scripts: { ...pkg.scripts, mutation: "scaffolding-mutation" },
      }),
    });
    expect(run(other, "check-structure")).toEqual({ code: 0, out: "" });
    const config = readFileSync(join(other, path), "utf8");
    write(other, { [path]: config.replace("lib/deck-edit.ts", "lib/deck-edit.ts:15-217") });
    const result = run(other, "check-structure");
    expect(result.code).toBe(1);
    expect(lines(result.out, "check-structure")).toEqual([
      "[check-structure] stryker.config.mjs: mutate must select whole files, without line ranges (lib/deck-edit.ts:15-217)",
    ]);
  });

  test("the tests pass the gate's SCAFFOLDING_TEST_TIMEOUT_MS on, in the command, its script or a vitest config", () => {
    const other = join(parent, "timeout");
    run(parent, "scaffold", ["timeout", "--catalog-in", "x", "--admin-in", "x"]);
    install(other);
    write(other, { "bun.lock": "" });
    sh(other, ["config", "core.hooksPath", ".githooks"]);
    const pkg = scaffolded(other);
    pkg.scaffolding.skip.lint = "fixture checks the test runner timeout";
    const structure = (
      scaffolding: object,
      scripts: object,
      files: Record<string, string> = {},
    ) => {
      write(other, {
        "package.json": JSON.stringify({
          ...pkg,
          scripts: { ...pkg.scripts, ...scripts },
          scaffolding: {
            ...pkg.scaffolding,
            skip: { ...pkg.scaffolding.skip, test: undefined },
            ...scaffolding,
          },
        }),
        ...files,
      });
      return lines(run(other, "check-structure").out, "check-structure");
    };
    const red = [
      "[check-structure] package.json: scaffolding.test passes no SCAFFOLDING_TEST_TIMEOUT_MS on: bun test --timeout ${SCAFFOLDING_TEST_TIMEOUT_MS:-5000}, vitest's testTimeout read from it, or the shared Vitest base (test)",
    ];
    expect(structure({ test: "test" }, { test: "bun test" })).toEqual(red);
    expect(
      structure(
        { test: "test" },
        { test: "bun test --timeout ${SCAFFOLDING_TEST_TIMEOUT_MS:-5000}" },
      ),
    ).toEqual([]);
    // `bun test` is bun's runner, not the script named test; a word that names no script of its
    // own, such as toString, is none.
    expect(
      structure(
        { test: "bun test -t toString" },
        { test: "bun test --timeout ${SCAFFOLDING_TEST_TIMEOUT_MS:-5000}" },
      ),
    ).toEqual([red[0].replace("(test)", "(bun test -t toString)")]);
    // Through `bun run` and a script naming another.
    expect(
      structure(
        { test: "bun run test" },
        {
          test: "bun run test:unit",
          "test:unit": "bun test --timeout ${SCAFFOLDING_TEST_TIMEOUT_MS:-5000}",
        },
      ),
    ).toEqual([]);
    expect(structure({ test: "vitest run" }, {})).toEqual([
      red[0].replace("(test)", "(vitest run)"),
    ]);
    expect(
      structure(
        { test: "vitest run" },
        {},
        {
          "vitest.config.ts":
            "export default { test: { testTimeout: Number(process.env.SCAFFOLDING_TEST_TIMEOUT_MS ?? 5000) } };\n",
        },
      ),
    ).toEqual([]);
    for (const config of [
      'export { default } from "@hackersandwizards/scaffolding/vitest";',
      'import base from "@hackersandwizards/scaffolding/vitest";\nexport default base;',
      'import { mergeConfig } from "vitest/config";\nimport base from "@hackersandwizards/scaffolding/vitest";\nexport default mergeConfig(base, { test: { include: ["test/*.ts"] } });',
    ])
      expect(structure({ test: "vitest run" }, {}, { "vitest.config.ts": config })).toEqual([]);
    for (const config of [
      '// export { default } from "@hackersandwizards/scaffolding/vitest";',
      "const mention = 'export { default } from \"@hackersandwizards/scaffolding/vitest\";';\nexport default {};",
      'import base from "@hackersandwizards/scaffolding/vitest";\nexport default {};',
    ])
      expect(structure({ test: "vitest run" }, {}, { "vitest.config.ts": config })).toEqual([
        red[0].replace("(test)", "(vitest run)"),
      ]);
    // A skipped test step runs nothing to pass it to.
    rmSync(join(other, "vitest.config.ts"));
    expect(structure({ skip: pkg.scaffolding.skip }, {})).toEqual([]);
  });

  test(
    "a repository with a surface carries the catalog and validates its local steps",
    () => {
      const other = join(parent, "surface");
      run(parent, "scaffold", ["surface", "--catalog-in", "x", "--admin-in", "x"]);
      install(other);
      write(other, { "bun.lock": "" });
      sh(other, ["config", "core.hooksPath", ".githooks"]);
      const pkg = scaffolded(other);
      // false gives no reason, as a missing skip.catalog does.
      pkg.scaffolding.skip.catalog = false;
      pkg.scaffolding.check = ["brand-colours", ["check:markers", "lint"]];
      pkg.scripts["check:markers"] = "true";
      write(other, { "package.json": JSON.stringify(pkg) });
      const found = lines(run(other, "check-structure").out, "check-structure");
      expect(found.sort()).toEqual([
        "[check-structure] catalog/astro.config.ts: the Astro config must use the catalog preset from @hackersandwizards/scaffolding/catalog",
        "[check-structure] package.json: a step of scaffolding.check is a script named check:<what> (brand-colours)",
        "[check-structure] package.json: a step of scaffolding.check is a script named check:<what> (lint)",
        "[check-structure] package.json: script build missing (build)",
        "[check-structure] package.json: script catalog missing (catalog)",
        "[check-structure] package.json: script dev missing (dev)",
      ]);
      pkg.scaffolding.check = [["check:markers"]];
      Object.assign(pkg.scripts, { dev: "x", catalog: "x", build: "x" });
      write(other, {
        "package.json": JSON.stringify(pkg),
        // A comment naming the preset is not a use of it.
        "catalog/astro.config.ts": "// @hackersandwizards/scaffolding/catalog\n",
      });
      expect(lines(run(other, "check-structure").out, "check-structure")).toEqual([
        "[check-structure] catalog/astro.config.ts: the Astro config must use the catalog preset from @hackersandwizards/scaffolding/catalog",
      ]);
      write(other, {
        "catalog/astro.config.ts":
          'import { catalog } from "@hackersandwizards/scaffolding/catalog";\nexport default { integrations: [catalog] };\n',
      });
      expect(run(other, "check-structure").code).toBe(0);
      // A catalog with no stories yet needs no folder for them, which git cannot keep empty.
      mkdirSync(join(other, "talks"));
      renameSync(join(other, "catalog/astro.config.ts"), join(other, "talks/astro.config.ts"));
      expect(run(other, "check-structure").code).toBe(0);
      // Under every name Astro reads.
      for (const ext of ["js", "mts"]) {
        const to = join(other, `talks/astro.config.${ext}`);
        renameSync(join(other, "talks", readdirSync(join(other, "talks"))[0]!), to);
        expect(run(other, "check-structure").out).toBe("");
      }
    },
    limit(10_000),
  );

  test("a private repository keeps no commit-msg hook", () => {
    const other = fixture("private", { private: true });
    expect(lines(run(other, "check-structure").out, "check-structure").sort()).toEqual([
      "[check-structure] .githooks/commit-msg: not kept in a private repository (check-structure --fix)",
    ]);
    run(other, "check-structure", ["--fix"]);
    expect(run(other, "check-structure").code).toBe(0);
    expect(existsSync(join(other, ".githooks/commit-msg"))).toBe(false);
  });

  test("a repository without package.json is reported, not a crash", () => {
    const r = run(repo({ "a.md": "a\n" }), "check-structure");
    expect(r.code).toBe(1);
    expect(r.out).toContain("[check-structure] package.json: missing");
  });

  test("a scaffolded repository passes check-coupling but for the pins bun install fetches", () => {
    expect(lines(run(dir, "check-coupling").out, "check-coupling")).toEqual([
      "[check-coupling] package.json: node_modules holds nothing, not the pinned 0.10.0: bun install (@hackersandwizards/admin@git+https://github.com/hackersandwizards/admin.git#v0.10.0)",
      "[check-coupling] package.json: node_modules holds nothing, not the pinned 0.10.0: bun install (@hackersandwizards/brand@git+https://github.com/hackersandwizards/brand.git#v0.10.0)",
    ]);
  });
});

describe("check-confidential", () => {
  const names = join(temp(), "names.txt");
  writeFileSync(names, "Acme Widgets GmbH\nJane Q Doe\nZYX\nEvery\n");
  const list = join(temp(), "list.json");
  const buildStarted = Date.now();
  writeFileSync(list, run(temp(), "check-confidential", ["build", names]).out);
  const buildFinished = Date.now();
  const env = { SCAFFOLDING_CONFIDENTIAL_TERMS: list, CI: "" };

  test("the list holds hashes, not names, drops dictionary words and carries its build time", () => {
    const text = readFileSync(list, "utf8");
    expect(text).not.toMatch(/acme|jane|zyx/i);
    expect(jsonObject(text).hashes).toHaveLength(4);
    const built = Date.parse(String(jsonObject(text).built));
    expect(built).toBeGreaterThanOrEqual(buildStarted);
    expect(built).toBeLessThanOrEqual(buildFinished);
  });

  test("a term the public text already carries is left out, its legal-form variant too", () => {
    const pub = join(temp(), "public.txt");
    writeFileSync(pub, "<p>Our clients include Acme Widgets.</p>");
    const r = spawnSync(
      process.execPath,
      [bin("check-confidential"), "build", "-", "--public", pub],
      {
        input: "Acme Widgets GmbH\nJane Q Doe\n",
        encoding: "utf8",
      },
    );
    expect(jsonObject(r.stdout).hashes).toHaveLength(1);
  });

  test("a staged name goes red, ordinary text stays green", () => {
    const dir = repo({ "package.json": "{}", "a.md": "nothing\n" });
    write(dir, { "a.md": "nothing\nWe met jane q doe and every ZYX team.\n" });
    sh(dir, ["add", "a.md"]);
    const found = lines(
      run(dir, "check-confidential", ["--staged"], env).out,
      "check-confidential",
    );
    expect(found.map((l) => l.replace(/.*\(/, "")).sort()).toEqual(["ZYX)", "jane q doe)"]);
    write(dir, { "a.md": "nothing\nzyx in lower case is a word here.\n" });
    sh(dir, ["add", "a.md"]);
    expect(run(dir, "check-confidential", ["--staged"], env).code).toBe(0);
  });

  test("the tree audit reads every file, and a staged finding names a non-ASCII path as written", () => {
    const dir = repo({
      "package.json": "{}",
      "a.md": "nothing\n",
      "b.md": "We met jane q doe.\n",
      "c/d.md": "Every ZYX team.\n",
    });
    const audit = lines(
      run(dir, "check-confidential", ["--tree", "HEAD"], env).out,
      "check-confidential",
    );
    expect(audit.map((l) => l.replace(/:.*\(/, " (")).sort()).toEqual([
      "[check-confidential] b.md (jane q doe)",
      "[check-confidential] c/d.md (ZYX)",
    ]);
    write(dir, { "café.md": "We met jane q doe.\n" });
    sh(dir, ["add", "café.md"]);
    sh(dir, ["config", "diff.mnemonicPrefix", "true"]);
    expect(run(dir, "check-confidential", ["--staged"], env).out).toContain(
      "[check-confidential] café.md:",
    );
  });

  test("the tree audit checks a submodule's path and fails on an object it cannot read", () => {
    const dir = repo({ "package.json": "{}", "a.md": "nothing\n" });
    const head = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
    sh(dir, ["update-index", "--add", "--cacheinfo", `160000,${head},ZYX`]);
    sh(dir, ["commit", "-qm", "sub"]);
    expect(run(dir, "check-confidential", ["--tree", "HEAD"], env).out).toContain("(ZYX)");
    const sha = sh(dir, ["rev-parse", "HEAD:a.md"]).stdout.toString().trim();
    rmSync(join(dir, ".git/objects", sha.slice(0, 2), sha.slice(2)));
    const broken = run(dir, "check-confidential", ["--tree", "HEAD"], env);
    expect(broken.out).toContain("a.md not readable");
    expect(broken.code).not.toBe(0);
  });

  test("a one-word name in capitals matches only in capitals, a dictionary word included", () => {
    const caps = join(temp(), "caps.txt");
    writeFileSync(caps, "QUUX\nBRIDGE\nWidgetco\n");
    const capsList = join(temp(), "caps.json");
    writeFileSync(capsList, run(temp(), "check-confidential", ["build", caps]).out);
    const capsEnv = { SCAFFOLDING_CONFIDENTIAL_TERMS: capsList, CI: "" };
    const dir = repo({ "package.json": "{}", "a.md": "nothing\n" });
    write(dir, { "a.md": "nothing\nQUUX and BRIDGE ship, so does widgetco.\n" });
    sh(dir, ["add", "a.md"]);
    const found = lines(
      run(dir, "check-confidential", ["--staged"], capsEnv).out,
      "check-confidential",
    );
    expect(found.map((l) => l.replace(/.*\(/, "")).sort()).toEqual([
      "BRIDGE)",
      "QUUX)",
      "widgetco)",
    ]);
    write(dir, { "a.md": "nothing\nquux, Quux, the bridge and a Bridge stay ordinary words.\n" });
    sh(dir, ["add", "a.md"]);
    expect(run(dir, "check-confidential", ["--staged"], capsEnv).code).toBe(0);
    write(dir, { "a.md": "nothing\nsee docs/quux-workshop/index.html\n" });
    sh(dir, ["add", "a.md"]);
    expect(
      lines(run(dir, "check-confidential", ["--staged"], capsEnv).out, "check-confidential"),
    ).toHaveLength(1);
  });

  test("only added lines count", () => {
    const dir = repo({ "package.json": "{}", "a.md": "Acme Widgets GmbH\n" });
    write(dir, { "a.md": "Acme Widgets GmbH\nmore\n" });
    sh(dir, ["add", "a.md"]);
    expect(run(dir, "check-confidential", ["--staged"], env).code).toBe(0);
  });

  test("the commit message is checked", () => {
    const dir = repo({ "package.json": "{}" });
    const msg = join(dir, "MSG");
    writeFileSync(msg, "fix: for Acme Widgets\n");
    expect(run(dir, "check-confidential", ["--message-file", msg], env).out).toContain(
      "(Acme Widgets)",
    );
    writeFileSync(
      msg,
      "fix\n# ------------------------ >8 ------------------------\n+Acme Widgets\n",
    );
    expect(run(dir, "check-confidential", ["--message-file", msg], env).code).toBe(0);
  });

  test("an image under docs/agent-work passes once read clean; one that cannot be read goes red", () => {
    const dir = repo({ "package.json": "{}" });
    mkdirSync(join(dir, "docs/agent-work/review"), { recursive: true });
    writeFileSync(join(dir, "docs/agent-work/review/shot.png"), PNG);
    sh(dir, ["add", "docs/agent-work/review/shot.png"]);
    expect(run(dir, "check-confidential", ["--staged"], { ...env, CI: "" }).code).toBe(0);
    write(dir, { "docs/agent-work/review/broken.png": "not really a png" });
    sh(dir, ["add", "docs/agent-work/review/broken.png"]);
    const r = run(dir, "check-confidential", ["--staged"], { ...env, CI: "" });
    expect(r.out).toContain("docs/agent-work/review/broken.png: image not read");
    expect(r.code).toBe(1);
  });

  test("review findings: comment lines, file names, decomposed text and '++ ' lines count", () => {
    const dir = repo({ "package.json": "{}" });
    const msg = join(dir, "MSG");
    writeFileSync(msg, "# Acme Widgets deal\n");
    expect(run(dir, "check-confidential", ["--message-file", msg], env).code).toBe(1);
    write(dir, {
      "notes/acme-widgets.md": "x\n",
      "a.md": "Jane Q Doe".normalize("NFD") + "\n++ Acme Widgets\n",
    });
    sh(dir, ["add", "notes/acme-widgets.md", "a.md"]);
    const found = lines(
      run(dir, "check-confidential", ["--staged"], env).out,
      "check-confidential",
    );
    expect(found).toContain(
      "[check-confidential] notes/acme-widgets.md: confidential term from the company records in the file's path (acme widgets)",
    );
    expect(found.filter((l) => l.startsWith("[check-confidential] a.md:"))).toHaveLength(2);
  });

  test("the staged diff: '++ ' after '-- ' is an added line, a path with a space keeps its entry", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        scaffolding: {
          allow: [{ check: "confidential", path: "docs/my notes.md", reason: "test" }],
        },
      }),
      "notes.sql": "select 1;\n-- old note\n",
    });
    write(dir, { "notes.sql": "select 1;\n++ Acme Widgets\n", "docs/my notes.md": "ZYX\n" });
    sh(dir, ["add", "notes.sql", "docs/my notes.md"]);
    expect(
      lines(run(dir, "check-confidential", ["--staged"], env).out, "check-confidential"),
    ).toEqual([
      "[check-confidential] notes.sql: confidential term from the company records (Acme Widgets)",
    ]);
  });

  test("CI skips the term scan in a full audit only, never in a commit's own scans", () => {
    const dir = repo({ "package.json": "{}", "a.md": "nothing\n" });
    write(dir, { "a.md": "nothing\nAcme Widgets\n" });
    sh(dir, ["add", "a.md"]);
    const ci = { ...env, CI: "true" };
    expect(run(dir, "check-confidential", ["--index"], ci).code).toBe(0);
    expect(run(dir, "check-confidential", ["--staged"], ci).out).toContain("(Acme Widgets)");
    const msg = join(dir, "MSG");
    writeFileSync(msg, "for Acme Widgets\n");
    expect(run(dir, "check-confidential", ["--message-file", msg], ci).code).toBe(1);
  });

  test("terms the scan could not produce: seven words, two characters, a three-letter slug", () => {
    const terms = join(temp(), "short.txt");
    writeFileSync(terms, "Alpha Bravo Charlie Delta Echo Foxtrot Golfo\nK 2\nZYX\n");
    const shortList = join(temp(), "short.json");
    writeFileSync(shortList, run(temp(), "check-confidential", ["build", terms]).out);
    const shortEnv = { SCAFFOLDING_CONFIDENTIAL_TERMS: shortList, CI: "" };
    const found = (text: string) =>
      lines(
        run(
          repo({ "package.json": "{}", "a.md": text }),
          "check-confidential",
          ["--index"],
          shortEnv,
        ).out,
        "check-confidential",
      ).map((l) => l.replace(/.*\(/, "("));
    expect(found("Alpha Bravo Charlie Delta Echo Foxtrot Golfo\n")).toEqual([
      "(Alpha Bravo Charlie Delta Echo Foxtrot)",
    ]);
    expect(found("the K 2 team, see clients/zyx/ and zyx-workshop\n").sort()).toEqual([
      "(K 2)",
      "(zyx)",
    ]);
    // In lower case two letters are code.
    expect(found("const k = (k) => k 2;\n")).toEqual([]);
  });

  test("a binary file is read or refused: Office and zip files, fonts, anything else", () => {
    const dir = repo({ "package.json": "{}" });
    // Word splits a sentence into runs, here inside a word and between two.
    mkdirSync(join(dir, "d/word"), { recursive: true });
    write(dir, {
      "d/word/document.xml":
        '<?xml version="1.0"?><w:document><w:p><w:r><w:t>We met Acme Wid</w:t></w:r><w:r><w:t>gets</w:t></w:r></w:p><w:p><w:r><w:t>and Jane Q</w:t></w:r><w:r><w:t xml:space="preserve"> Doe</w:t></w:r></w:p></w:document>',
    });
    expect(spawnSync("zip", ["-qr", "../offer.docx", "word"], { cwd: join(dir, "d") }).status).toBe(
      0,
    );
    rmSync(join(dir, "d"), { recursive: true });
    writeFileSync(join(dir, "font.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2]));
    writeFileSync(join(dir, "data.bin"), Buffer.from("x\0y ZYX"));
    sh(dir, ["add", "offer.docx", "font.woff2", "data.bin"]);
    const expected = [
      "[check-confidential] data.bin: binary file not read: name it with a reason in scaffolding.allow",
      "[check-confidential] offer.docx: confidential term from the company records (Acme Widgets)",
      "[check-confidential] offer.docx: confidential term from the company records (Jane Q Doe)",
    ];
    for (const mode of ["--staged", "--index", "--index"])
      expect(
        lines(run(dir, "check-confidential", [mode], env).out, "check-confidential").sort(),
      ).toEqual(expected);
    // Kept by content: the document and the font, never the file not read.
    expect(readdirSync(join(dir, "node_modules/.cache/scaffolding/read"))).toHaveLength(2);
  });

  test("changing just the XML decoder invalidates cached document text", () => {
    const dir = repo({ "package.json": "{}" });
    write(dir, { "word/document.xml": "<w:t>Acme&nbsp;Widgets</w:t>" });
    expect(spawnSync("zip", ["-qr", "document.docx", "word"], { cwd: dir }).status).toBe(0);
    expect(sh(dir, ["add", "document.docx"]).status).toBe(0);
    const copy = temp();
    const root = join(import.meta.dirname, "..");
    for (const part of ["lib", "config"])
      cpSync(join(root, part), join(copy, part), { recursive: true });
    write(copy, { "bin/check-confidential.ts": readFileSync(bin("check-confidential"), "utf8") });
    const scan = () => {
      const result = spawnSync(
        process.execPath,
        ["--no-env-file", join(copy, "bin/check-confidential.ts"), "--index"],
        { cwd: dir, env: { ...process.env, ...env, CI: "" }, encoding: "utf8" },
      );
      return { status: result.status, output: result.stdout + result.stderr };
    };
    const first = scan();
    expect(first.status, first.output).toBe(0);
    expect(readdirSync(join(dir, "node_modules/.cache/scaffolding/read"))).toContainEqual(
      expect.stringMatching(/^[a-f0-9]{32}$/),
    );
    const decoder = join(copy, "lib/confidential-input.ts");
    const source = readFileSync(decoder, "utf8");
    const updated = source.replace(
      "const ENTITY = new Map([",
      'const ENTITY = new Map([["nbsp", " "],',
    );
    expect(updated).not.toBe(source);
    writeFileSync(decoder, updated);

    const second = scan();
    expect(second.status, second.output).toBe(1);
    expect(second.output).toContain(
      "document.docx: confidential term from the company records (Acme Widgets)",
    );
  });

  test("a Git LFS file is read where its content is at hand, from the working tree or the store", () => {
    const dir = repo({ "package.json": "{}" });
    mkdirSync(join(dir, "d/word"), { recursive: true });
    write(dir, { "d/word/document.xml": "<w:t>We met Acme Widgets</w:t>" });
    expect(spawnSync("zip", ["-qr", "../offer.docx", "word"], { cwd: join(dir, "d") }).status).toBe(
      0,
    );
    rmSync(join(dir, "d"), { recursive: true });
    const content = readFileSync(join(dir, "offer.docx"));
    const oid = createHash("sha256").update(content).digest("hex");
    // The index holds the pointer git-lfs would stage, the working tree the file it names.
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`;
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: pointer })
      .stdout.toString()
      .trim();
    sh(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},offer.docx`]);
    const found = (mode: string) =>
      lines(run(dir, "check-confidential", [mode], env).out, "check-confidential");
    const term = "[check-confidential] offer.docx: confidential term from the company records";
    for (const mode of ["--staged", "--index"])
      expect(found(mode)).toEqual([`${term} (Acme Widgets)`]);
    // A working tree that differs from the pointer is not what the index holds; the store is.
    writeFileSync(join(dir, "offer.docx"), "changed since");
    const missing = "[check-confidential] offer.docx: Git LFS pointer, not read";
    for (const mode of ["--staged", "--index"]) expect(found(mode)).toEqual([missing]);
    const stored = join(dir, ".git/lfs/objects", oid.slice(0, 2), oid.slice(2, 4));
    mkdirSync(stored, { recursive: true });
    writeFileSync(join(stored, oid), content);
    for (const mode of ["--staged", "--index"])
      expect(found(mode)).toEqual([`${term} (Acme Widgets)`]);
    // A text file kept in Git LFS is scanned as text, not refused as an unread binary.
    const notes = Buffer.from("We met Jane Q Doe.\n");
    const noted = createHash("sha256").update(notes).digest("hex");
    writeFileSync(join(dir, "notes.json"), notes);
    const textBlob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: dir,
      input: `version https://git-lfs.github.com/spec/v1\noid sha256:${noted}\nsize ${notes.length}\n`,
    })
      .stdout.toString()
      .trim();
    sh(dir, ["update-index", "--add", "--cacheinfo", `100644,${textBlob},notes.json`]);
    for (const mode of ["--staged", "--index"])
      expect(found(mode)).toContain(
        "[check-confidential] notes.json: confidential term from the company records (Jane Q Doe)",
      );
    // A text that only starts like a pointer is read as text.
    write(dir, { "lfs.md": "version https://git-lfs.github.com/spec/v1\nWe met Acme Widgets.\n" });
    sh(dir, ["add", "lfs.md"]);
    for (const mode of ["--staged", "--index"])
      expect(found(mode)).toContain(`${term.replace("offer.docx", "lfs.md")} (Acme Widgets)`);
  });

  test("no setting or name changes what is read, and a damaged archive is refused", () => {
    const dir = repo({ "package.json": "{}" });
    mkdirSync(join(dir, "d/word"), { recursive: true });
    write(dir, {
      "d/word/document.xml": "<w:document><w:p>Acme Widgets &#99999999;</w:p></w:document>",
      ".gitattributes": "*.docx diff=shown\n",
      "b.md": "for Jane Q Doe\n",
    });
    expect(spawnSync("zip", ["-qr", "../offer.docx", "word"], { cwd: join(dir, "d") }).status).toBe(
      0,
    );
    rmSync(join(dir, "d"), { recursive: true });
    // A picture under a font's name, and an archive whose directory points past its end.
    writeFileSync(join(dir, "logo.woff"), Buffer.from("\x89PNG\r\n\x1a\n\0\0\0\rIHDR", "latin1"));
    writeFileSync(
      join(dir, "broken.zip"),
      Buffer.concat([
        Buffer.from("PK\x03\x04\0\0PK\x05\x06\0\0\0\0\x01\0\x01\0", "latin1"),
        Buffer.from([0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0]),
      ]),
    );
    sh(dir, ["config", "diff.shown.textconv", "echo"]);
    sh(dir, ["config", "diff.submodule", "log"]);
    const sub = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
    sh(dir, ["update-index", "--add", "--cacheinfo", `160000,${sub},a-sub`]);
    sh(dir, ["add", ".gitattributes", "offer.docx", "b.md", "logo.woff", "broken.zip"]);
    expect(
      lines(run(dir, "check-confidential", ["--staged"], env).out, "check-confidential")
        .map((l) => l.replace(/ \(.*/, ""))
        .sort(),
    ).toEqual([
      "[check-confidential] b.md: confidential term from the company records",
      "[check-confidential] broken.zip: archive not read: damaged zip archive",
      "[check-confidential] logo.woff: binary file not read: name it with a reason in scaffolding.allow",
      "[check-confidential] offer.docx: confidential term from the company records",
    ]);
  });

  test.runIf(process.platform === "darwin")(
    "OCR reads a transparent image, every page of a TIFF and a PDF page without text or with an image",
    () => {
      const dir = repo({ "package.json": "{}" });
      const make = (args: string[]) =>
        expect(spawnSync(args[0], args.slice(1), { cwd: dir }).status).toBe(0);
      const page = (text: string, name: string) => {
        writeFileSync(join(dir, `${name}.txt`), `${text}\n`);
        const pdf = spawnSync(
          "cupsfilter",
          ["-i", "text/plain", "-m", "application/pdf", `${name}.txt`],
          {
            cwd: dir,
          },
        );
        writeFileSync(join(dir, `${name}.pdf`), pdf.stdout);
        // sips renders the page on a transparent ground.
        make(["sips", "-Z", "1600", "-s", "format", "png", `${name}.pdf`, "--out", `${name}.png`]);
        rmSync(join(dir, `${name}.txt`));
        rmSync(join(dir, `${name}.pdf`));
      };
      // A PDF page with a caption over a picture of text: the picture is a JPEG drawn on the page.
      writeFileSync(join(dir, "figure.txt"), "We met Jane Q Doe here\n");
      const printed = spawnSync(
        "cupsfilter",
        ["-i", "text/plain", "-m", "application/pdf", "figure.txt"],
        {
          cwd: dir,
        },
      );
      writeFileSync(join(dir, "figure-text.pdf"), printed.stdout);
      make(["pdftoppm", "-r", "100", "-jpeg", "-singlefile", "figure-text.pdf", "figure"]);
      const jpeg = readFileSync(join(dir, "figure.jpg"));
      const [width, height] = ["pixelWidth", "pixelHeight"].map((key) =>
        Number(
          new RegExp(`${key}: (\\d+)`).exec(
            spawnSync("sips", ["-g", key, "figure.jpg"], { cwd: dir }).stdout.toString(),
          )![1],
        ),
      );
      const content = "q 612 0 0 792 0 0 cm /Im1 Do Q BT /F1 10 Tf 280 20 Td (Figure 1) Tj ET";
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ];
      const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
      const offsets: number[] = [];
      const size = () => parts.reduce((n, b) => n + b.length, 0);
      objects.forEach((body, i) => {
        offsets.push(size());
        parts.push(Buffer.from(`${i + 1} 0 obj\n${body}`, "latin1"));
        if (i === 5) parts.push(jpeg, Buffer.from("\nendstream"));
        parts.push(Buffer.from("\nendobj\n"));
      });
      const xref = size();
      parts.push(
        Buffer.from(
          `xref\n0 7\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
        ),
      );
      writeFileSync(join(dir, "figure.pdf"), Buffer.concat(parts));
      for (const f of ["figure.txt", "figure-text.pdf", "figure.jpg"]) rmSync(join(dir, f));
      expect(spawnSync("pdftotext", ["figure.pdf", "-"], { cwd: dir }).stdout.toString()).toContain(
        "Figure 1",
      );
      page("We met Acme Widgets here", "clear");
      page("nothing to see here", "blank");
      page("We met Jane Q Doe here", "jane");
      make(["sips", "-s", "format", "pdf", "jane.png", "--out", "scan.pdf"]);
      make(["sips", "-s", "format", "tiff", "blank.png", "--out", "blank.tiff"]);
      make(["sips", "-s", "format", "tiff", "jane.png", "--out", "jane.tiff"]);
      make(["tiffutil", "-cat", "blank.tiff", "jane.tiff", "-out", "pages.tiff"]);
      for (const f of ["blank.png", "jane.png", "blank.tiff", "jane.tiff"]) rmSync(join(dir, f));
      sh(dir, ["add", "clear.png", "scan.pdf", "pages.tiff", "figure.pdf"]);
      expect(
        lines(run(dir, "check-confidential", ["--staged"], env).out, "check-confidential").sort(),
      ).toEqual([
        "[check-confidential] clear.png: confidential term from the company records (Acme Widgets)",
        "[check-confidential] figure.pdf: confidential term from the company records (Jane Q Doe)",
        "[check-confidential] pages.tiff: confidential term from the company records (Jane Q Doe)",
        "[check-confidential] scan.pdf: confidential term from the company records (Jane Q Doe)",
      ]);
    },
    60_000,
  );

  test("an allow entry cannot switch off the list requirement", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        scaffolding: { allow: [{ check: "confidential", reason: "everything" }] },
      }),
    });
    write(dir, { "a.md": "x\n" });
    sh(dir, ["add", "a.md"]);
    const r = run(dir, "check-confidential", ["--staged"], {
      SCAFFOLDING_CONFIDENTIAL_TERMS: "/nonexistent",
      CI: "",
    });
    expect(r.out).toContain("Refused");
    expect(r.code).toBe(1);
  });

  test("the tree audit fails an allow entry that matches nothing; a staged scan cannot tell", () => {
    const kept = { check: "confidential", path: "a.md", reason: "test" };
    const gone = { check: "confidential", path: "gone.md", reason: "old" };
    const dir = repo({
      "package.json": JSON.stringify({ scaffolding: { allow: [kept, gone] } }),
      "a.md": "We met jane q doe.\n",
    });
    const audit = lines(
      run(dir, "check-confidential", ["--tree", "HEAD"], env).out,
      "check-confidential",
    );
    expect(audit).toEqual([
      `[check-confidential] package.json: allow entry matches nothing (${JSON.stringify(gone)})`,
    ]);
    write(dir, { "b.md": "x\n" });
    sh(dir, ["add", "b.md"]);
    expect(run(dir, "check-confidential", ["--staged"], env).code).toBe(0);
  });

  test("each scan reads the allow list of the snapshot it scans", () => {
    const entry = { check: "confidential", path: "people/jane/*", reason: "her own entry" };
    const pkg = (allow: object[]) => JSON.stringify({ scaffolding: { allow } });
    const audit = (dir: string, args = ["--index"]) =>
      run(dir, "check-confidential", args, env).out;
    const dir = repo({ "package.json": pkg([]), "a.md": "nothing\n" });
    // A commit adding a name's folder with its entry: the gate audits the index, HEAD has neither.
    write(dir, { "package.json": pkg([entry]), "people/jane/a.md": "Jane Q Doe\n" });
    sh(dir, ["add", "package.json", "people/jane/a.md"]);
    expect(audit(dir)).toBe("");
    expect(audit(dir, ["--tree", "HEAD"])).toBe("");
    // The staged entry covers the staged name while the working tree drops it.
    write(dir, { "package.json": pkg([]) });
    expect(audit(dir, ["--staged"])).toBe("");
    // The entry only in the working tree covers nothing staged.
    sh(dir, ["add", "package.json"]);
    write(dir, { "package.json": pkg([entry]) });
    expect(audit(dir, ["--staged"])).toContain("(Jane Q Doe)");
    sh(dir, ["add", "package.json"]);
    sh(dir, ["commit", "-qm", "jane"]);
    // A commit removing both: the index holds neither, HEAD both.
    sh(dir, ["rm", "-q", "people/jane/a.md"]);
    write(dir, { "package.json": pkg([]) });
    sh(dir, ["add", "package.json"]);
    expect(audit(dir)).toBe("");
    expect(audit(dir, ["--tree", "HEAD"])).toBe("");
    // A name already committed, its entry staged: the commit adding the entry passes the gate.
    const named = repo({ "package.json": pkg([]), "people/jane/a.md": "Jane Q Doe\n" });
    expect(audit(named)).toContain("(Jane Q Doe)");
    write(named, { "package.json": pkg([entry]) });
    sh(named, ["add", "package.json"]);
    expect(audit(named)).toBe("");
    // A bad revision fails rather than read as a package without allow entries.
    expect(run(named, "check-confidential", ["--tree", "nope"], env).code).not.toBe(0);
    // An unmerged index has no single file to scan.
    sh(named, ["commit", "-qm", "entry"]);
    sh(named, ["checkout", "-qb", "side"]);
    write(named, { "a.md": "side\n" });
    sh(named, ["add", "a.md"]);
    sh(named, ["commit", "-qm", "side"]);
    sh(named, ["checkout", "-q", "-"]);
    write(named, { "a.md": "main\n" });
    sh(named, ["add", "a.md"]);
    sh(named, ["commit", "-qm", "main"]);
    spawnSync("git", ["merge", "-q", "side"], { cwd: named });
    expect(audit(named)).toContain("a.md: unmerged");
  });

  test("an entry's text is the whole term in any case; a longer term containing it stays red", () => {
    const entry = (text: string | string[]) => ({
      check: "confidential",
      text,
      reason: "test",
    });
    const audit = (text: string | string[], body: string) =>
      lines(
        run(
          repo({
            "package.json": JSON.stringify({ scaffolding: { allow: [entry(text)] } }),
            "a.md": body,
          }),
          "check-confidential",
          ["--tree", "HEAD"],
          env,
        ).out,
        "check-confidential",
      );
    expect(audit("Jane Q Doe".normalize("NFD"), "JANE Q DOE and jane q doe\n")).toEqual([]);
    expect(audit("Jane-Q. Doe", "Jane Q Doe\n")).toEqual([]);
    expect(audit("Acme Widgets", "Acme Widgets GmbH\n")).toEqual([
      "[check-confidential] a.md: confidential term from the company records (Acme Widgets GmbH)",
    ]);
    expect(
      audit(
        ["jane q doe", "acme widgets gmbh", "acme widgets", "zyx"],
        "Jane Q Doe, Acme Widgets GmbH\n",
      ),
    ).toEqual([
      `[check-confidential] package.json: allow entry matches nothing (${JSON.stringify(entry("zyx"))})`,
    ]);
  });

  test("one entry's path list covers a person's folder; package.json and a gone path die alone", () => {
    const allow = [
      {
        check: "confidential",
        path: ["people/jane-q-doe/**", "package.json", "gone/**"],
        text: "Jane Q Doe",
        reason: "test",
      },
    ];
    const out = run(
      repo({
        "package.json": JSON.stringify({ scaffolding: { allow } }),
        "people/jane-q-doe/index.md": "Jane Q Doe\n",
        "other.md": "Jane Q Doe\n",
      }),
      "check-confidential",
      ["--tree", "HEAD"],
      env,
    ).out;
    expect(lines(out, "check-confidential")).toEqual([
      "[check-confidential] other.md: confidential term from the company records (Jane Q Doe)",
      // Each path of the list dies with its own case; package.json's own entries are no case.
      `[check-confidential] package.json: allow entry matches nothing (${JSON.stringify({ ...allow[0], path: "package.json" })})`,
      `[check-confidential] package.json: allow entry matches nothing (${JSON.stringify({ ...allow[0], path: "gone/**" })})`,
    ]);
  });

  test("a term in a file's path is that file's: an entry naming the file covers it, file names all; with file names, the paths keep the names alone", () => {
    const files = {
      "people/acme-widgets.md": "Acme Widgets\n",
      "notes/acme-widgets.md": "x\n",
    };
    const scan = (allow: object[]) =>
      lines(
        run(
          repo({ "package.json": JSON.stringify({ scaffolding: { allow } }), ...files }),
          "check-confidential",
          ["--tree", "HEAD"],
          env,
        ).out,
        "check-confidential",
      );
    const entry = { check: "confidential", text: "Acme Widgets", reason: "test" };
    const content =
      "[check-confidential] people/acme-widgets.md: confidential term from the company records (Acme Widgets)";
    const notes =
      "[check-confidential] notes/acme-widgets.md: confidential term from the company records in the file's path (acme widgets)";
    expect(scan([{ ...entry, path: "people/**" }])).toEqual([notes]);
    expect(scan([{ ...entry, path: "file names" }])).toEqual([content]);
    // The entry says it is for the file names: the term in the same file's text stays red.
    expect(scan([{ ...entry, path: ["file names", "people/**"] }])).toEqual([notes, content]);
    const gone = { ...entry, path: ["file names", "people/**", "gone/**"] };
    expect(scan([gone])).toEqual([
      notes,
      content,
      `[check-confidential] package.json: allow entry matches nothing (${JSON.stringify({ ...gone, path: "gone/**" })})`,
    ]);
  });

  test.runIf(process.platform === "darwin")(
    "an image whose name holds a term is still kept as read",
    () => {
      const dir = repo({ "package.json": "{}" });
      writeFileSync(join(dir, "acme-widgets.png"), PNG);
      sh(dir, ["add", "acme-widgets.png"]);
      const r = run(dir, "check-confidential", ["--staged"], { ...env, CI: "" });
      expect(r.out).toContain("acme-widgets.png: confidential term");
      expect(readdirSync(join(dir, "node_modules/.cache/scaffolding/read"))).toHaveLength(1);
    },
  );

  test("package.json's allow entries are no finding there; the same term elsewhere in it is", () => {
    const allow = [
      { check: "confidential", path: "a.md", text: ["Acme Widgets", "Jane Q Doe"], reason: "test" },
    ];
    const pkg = (extra: object) => JSON.stringify({ ...extra, scaffolding: { allow } }, null, 2);
    const files = { "a.md": "Acme Widgets and Jane Q Doe\n" };
    const clean = repo({ "package.json": pkg({}), ...files });
    expect(run(clean, "check-confidential", ["--tree", "HEAD"], env).code).toBe(0);
    const named = repo({ "package.json": pkg({ description: "Acme Widgets" }), ...files });
    expect(
      lines(run(named, "check-confidential", ["--tree", "HEAD"], env).out, "check-confidential"),
    ).toEqual([
      "[check-confidential] package.json: confidential term from the company records (Acme Widgets)",
    ]);
    // A reason is prose, read as any other text.
    const reasoned = repo({
      "package.json": JSON.stringify(
        { scaffolding: { allow: [{ ...allow[0], reason: "asked by Acme Widgets" }] } },
        null,
        2,
      ),
      ...files,
    });
    expect(
      lines(run(reasoned, "check-confidential", ["--tree", "HEAD"], env).out, "check-confidential"),
    ).toEqual([
      "[check-confidential] package.json: confidential term from the company records (Acme Widgets)",
    ]);
    // The staged scan reads the added lines the same way.
    const staged = repo({ "package.json": "{}" });
    write(staged, { "package.json": pkg({}), ...files });
    sh(staged, ["add", "package.json", "a.md"]);
    expect(run(staged, "check-confidential", ["--staged"], env).code).toBe(0);
  });

  test.runIf(process.platform === "darwin")("an image that cannot be decoded is refused", () => {
    const dir = repo({ "package.json": "{}" });
    write(dir, { "bad.png": "not an image at all" });
    sh(dir, ["add", "bad.png"]);
    const r = run(dir, "check-confidential", ["--staged"], env);
    expect(r.out).toContain("bad.png: image not read");
    expect(r.code).toBe(1);
  });

  test("a repository marked private is not checked", () => {
    const dir = repo({ "package.json": JSON.stringify({ scaffolding: { private: true } }) });
    write(dir, { "a.md": "Acme Widgets GmbH\n" });
    sh(dir, ["add", "a.md"]);
    expect(run(dir, "check-confidential", ["--staged"], env).code).toBe(0);
  });

  test("an unstaged private flag leaves the scan of the index on", () => {
    const dir = repo({ "package.json": "{}" });
    write(dir, {
      "package.json": JSON.stringify({ scaffolding: { private: true } }),
      "a.md": "Acme Widgets GmbH\n",
    });
    sh(dir, ["add", "a.md"]);
    const r = run(dir, "check-confidential", ["--staged"], env);
    expect(r.out).toContain("a.md: confidential term");
    expect(r.code).toBe(1);
  });

  test("a push carrying a purged commit is refused, a clean one passes", () => {
    const remote = temp();
    sh(remote, ["init", "-q", "--bare"]);
    const dir = repo({ "package.json": "{}", "a.md": "a\n" });
    sh(dir, ["remote", "add", "origin", remote]);
    write(dir, { "b.md": "b\n" });
    sh(dir, ["add", "b.md"]);
    sh(dir, ["commit", "-qm", "purged"]);
    const purged = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
    write(dir, {
      ".confidential-purged.json": run(dir, "check-confidential", ["purged", purged]).out,
    });
    const push = (sha: string, name = "origin") =>
      spawnSync(process.execPath, [bin("check-confidential"), "prepush", name, remote], {
        cwd: dir,
        input: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
        encoding: "utf8",
      });
    const refused = push(purged);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("purged from this repository's history");
    const clean = sh(dir, ["rev-parse", "HEAD~1"]).stdout.toString().trim();
    expect(push(clean).status).toBe(0);
    // A stale tracking ref or a fetched pull request holding it hides nothing.
    sh(dir, ["update-ref", "refs/remotes/origin/main", purged]);
    sh(dir, ["update-ref", "refs/remotes/origin/pr/1", purged]);
    expect(push(purged).status).toBe(1);
    expect(push(purged, "backup").status).toBe(1);
    write(dir, { ".confidential-purged.json": '{"salt":"fixture"}' });
    const malformed = push(clean);
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("the list in this checkout does not parse");
    // The redirect of a `purged` that failed leaves the list empty.
    write(dir, { ".confidential-purged.json": "" });
    expect(push(clean).status).toBe(0);
  });

  test("a clone older than the list is refused by the list on the remote's default branch", () => {
    const remote = temp();
    sh(remote, ["init", "-q", "--bare"]);
    sh(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const dir = repo({ "package.json": "{}", "a.md": "a\n" });
    write(dir, { "b.md": "b\n" });
    sh(dir, ["add", "b.md"]);
    sh(dir, ["commit", "-qm", "purged"]);
    const purged = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
    // The rewrite: main without the purged commit, the list on it.
    sh(dir, ["reset", "-q", "--hard", "HEAD~1"]);
    write(dir, {
      ".confidential-purged.json": run(dir, "check-confidential", ["purged", purged]).out,
    });
    sh(dir, ["add", ".confidential-purged.json"]);
    sh(dir, ["commit", "-qm", "list"]);
    sh(dir, ["push", "-q", remote, "HEAD:refs/heads/main"]);
    // The old clone: the purged commit checked out, no list in its tree.
    sh(dir, ["checkout", "-q", purged]);
    const push = spawnSync(process.execPath, [bin("check-confidential"), "prepush", "x", remote], {
      cwd: dir,
      input: `refs/heads/x ${purged} refs/heads/x ${"0".repeat(40)}\n`,
      encoding: "utf8",
    });
    expect(push.stderr).toContain("purged from this repository's history");
    expect(push.status).toBe(1);
    // A list that does not parse, on the remote or here, refuses the push and says where.
    sh(dir, ["checkout", "-q", "main"]);
    write(dir, { ".confidential-purged.json": "{" });
    sh(dir, ["commit", "-qam", "broken"]);
    sh(dir, ["push", "-q", remote, "HEAD:refs/heads/main"]);
    sh(dir, ["checkout", "-q", "HEAD~1", "--", ".confidential-purged.json"]);
    write(dir, { "c.md": "c\n" });
    sh(dir, ["add", "c.md"]);
    sh(dir, ["commit", "-qam", "c"]);
    const tip = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
    const broken = spawnSync(
      process.execPath,
      [bin("check-confidential"), "prepush", "x", remote],
      {
        cwd: dir,
        input: `refs/heads/y ${tip} refs/heads/y ${"0".repeat(40)}\n`,
        encoding: "utf8",
      },
    );
    expect(broken.stderr).toContain("the list on the remote's default branch does not parse");
    expect(broken.status).toBe(1);
  });

  test("a remote list that does not arrive within SCAFFOLDING_FETCH_WAIT_S refuses the push", () => {
    const remote = temp();
    sh(remote, ["init", "-q", "--bare"]);
    const dir = repo({ "package.json": "{}", "a.md": "a\n" });
    sh(dir, ["push", "-q", remote, "HEAD:refs/heads/main"]);
    sh(dir, ["remote", "add", "origin", remote]);
    const push = (uploadpack: string, wait = "1") => {
      sh(dir, ["config", "remote.origin.uploadpack", uploadpack]);
      return spawnSync(process.execPath, [bin("check-confidential"), "prepush", "origin"], {
        cwd: dir,
        input: `refs/heads/x ${sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim()} refs/heads/x ${"0".repeat(40)}\n`,
        encoding: "utf8",
        env: { ...process.env, SCAFFOLDING_FETCH_WAIT_S: wait },
      });
    };
    const slow = push("sleep 3; git-upload-pack");
    expect(slow.stderr).toContain(
      "the list on the remote's default branch did not arrive within 1 s: run `git fetch origin`, then push again",
    );
    expect(slow.status).toBe(1);
    expect(push("git-upload-pack").status).toBe(0);
    // A bound past the longest timer is capped: uncapped, bun ended the fetch within half a second.
    expect(push("sleep 1; git-upload-pack", "2147484").status).toBe(0);
  });

  test("purged adds to the repository's list under its salt, a redirect's empty file included", () => {
    const dir = repo({ "package.json": "{}" });
    const purged = (shas: string[]) => {
      const { salt, hashes } = jsonObject(run(dir, "check-confidential", ["purged", ...shas]).out);
      const listed: unknown[] = Array.isArray(hashes) ? hashes : [];
      return { salt, hashes: listed };
    };
    const first = purged(["a".repeat(40)]);
    write(dir, { ".confidential-purged.json": JSON.stringify(first) });
    const both = purged(["b".repeat(40), "a".repeat(40)]);
    expect(both.salt).toBe(first.salt);
    expect(both.hashes).toHaveLength(2);
    expect(both.hashes).toContain(first.hashes[0]);
    sh(dir, ["add", ".confidential-purged.json"]);
    write(dir, { ".confidential-purged.json": "" });
    expect(purged(["b".repeat(40)])).toEqual(both);
    write(dir, { ".confidential-purged.json": "{}" });
    expect(purged(["b".repeat(40)])).toEqual(both);
    sh(dir, ["add", ".confidential-purged.json"]);
    const malformed = run(dir, "check-confidential", ["purged", "b".repeat(40)]);
    expect(malformed.code).toBe(1);
    expect(malformed.out).toContain(".confidential-purged.json does not parse");
  });

  test(
    "prepush hands the refs to Git LFS only where the push may carry LFS content",
    () => {
      const stub = temp();
      const log = join(stub, "log");
      const lfs = '#!/bin/sh\n[ "$1" = version ] && exit 0\necho "$*" >> "$LFS_LOG"\nexit 3\n';
      writeFileSync(join(stub, "git-lfs"), lfs, { mode: 0o755 });
      // A PATH holding git alone, so the machine's own git-lfs stays out of reach.
      const bare = temp();
      symlinkSync(Bun.which("git")!, join(bare, "git"));
      const push = (dir: string, PATH: string, remote = "origin", old = "0".repeat(40)) => {
        const head = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
        return spawnSync(process.execPath, [bin("check-confidential"), "prepush", remote, "x"], {
          cwd: dir,
          env: {
            ...process.env,
            PATH,
            LFS_LOG: log,
            GIT_EXEC_PATH: bare,
          },
          input: `refs/heads/main ${head} refs/heads/main ${old}\n`,
        }).status;
      };
      const logged = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
      const both = (dir: string, remote?: string, old?: string) => [
        push(dir, `${stub}:${bare}`, remote, old),
        push(dir, bare, remote, old),
      ];
      // Nothing of LFS: git-lfs is never started, installed or not; a .lfsconfig and an empty store
      // hold no objects.
      expect(both(repo({ "package.json": "{}" }))).toEqual([0, 0]);
      expect(both(repo({ "package.json": "{}", ".lfsconfig": "" }))).toEqual([0, 0]);
      const stored = repo({ "package.json": "{}" });
      mkdirSync(join(stored, ".git/lfs/objects/ab/cd"), { recursive: true });
      expect(both(stored)).toEqual([0, 0]);
      const moved = repo({ "package.json": "{}" });
      const elsewhere = temp();
      sh(moved, ["config", "lfs.storage", elsewhere]);
      expect(both(moved)).toEqual([0, 0]);
      expect(logged()).toBe("");
      // A store holding an object: git-lfs decides and its status is the hook's; without git-lfs the
      // push is refused.
      write(stored, { ".git/lfs/objects/ab/cd/abcd": "x" });
      expect(both(stored)).toEqual([3, 1]);
      write(elsewhere, { "objects/ab/cd/abcd": "x" });
      expect(both(moved)).toEqual([3, 1]);
      // No store, but a pushed commit changes a path under filter=lfs, committed raw where git-lfs
      // was never installed.
      const raw = repo(
        { "package.json": "{}", ".gitattributes": "*.bin filter=lfs\n", "a.bin": "x" },
        false,
      );
      const noLfs = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
      const rawGit = (args: string[]) =>
        spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
          cwd: raw,
          env: noLfs,
        });
      rawGit(["add", "-A"]);
      rawGit(["commit", "-qm", "raw"]);
      expect(existsSync(join(raw, ".git/lfs"))).toBe(false);
      expect(both(raw)).toEqual([3, 1]);
      // The same path committed before the push, already on a remote: nothing to carry.
      write(raw, { "b.md": "b\n" });
      rawGit(["add", "b.md"]);
      rawGit(["commit", "-qm", "b"]);
      sh(raw, ["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
      expect(both(raw)).toEqual([0, 0]);
      // A second remote lacks what origin holds, so the path is new there.
      expect(both(raw, "backup")).toEqual([3, 1]);
      // A push to a URL has no tracking refs: the remote's tip from the input counts instead.
      const before = sh(raw, ["rev-parse", "HEAD~1"]).stdout.toString().trim();
      expect(both(raw, "/elsewhere.git", before)).toEqual([0, 0]);
      // .git/info/attributes counts as well.
      const info = repo({ "package.json": "{}", "a.bin": "x" });
      write(info, { ".git/info/attributes": "*.bin filter=lfs\n" });
      expect(both(info)).toEqual([3, 1]);
      // A lockable path: git-lfs refuses a change to a file someone else locked, LFS or not.
      expect(
        both(repo({ "package.json": "{}", ".gitattributes": "*.psd lockable\n", "a.psd": "x" })),
      ).toEqual([3, 1]);
      const renamed = repo({
        "package.json": "{}",
        ".gitattributes": "*.psd lockable\n",
        "a.psd": "x",
      });
      expect(sh(renamed, ["update-ref", "refs/remotes/origin/main", "HEAD"]).status).toBe(0);
      expect(sh(renamed, ["config", "diff.renames", "true"]).status).toBe(0);
      expect(sh(renamed, ["mv", "a.psd", "a.txt"]).status).toBe(0);
      expect(sh(renamed, ["commit", "-qm", "rename", "a.psd", "a.txt"]).status).toBe(0);
      expect(both(renamed)).toEqual([3, 1]);
      // A merge whose resolution alone changes a lockable path.
      const merged = repo({
        "package.json": "{}",
        ".gitattributes": "*.psd lockable\n",
        "a.psd": "x",
      });
      sh(merged, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      sh(merged, ["checkout", "-qb", "side"]);
      sh(merged, ["commit", "-q", "--allow-empty", "-m", "c"]);
      sh(merged, ["checkout", "-q", "main"]);
      sh(merged, ["commit", "-q", "--allow-empty", "-m", "d"]);
      sh(merged, ["merge", "-q", "--no-commit", "side"]);
      write(merged, { "a.psd": "y" });
      sh(merged, ["commit", "-qam", "m"]);
      expect(both(merged)).toEqual([3, 1]);
      expect(logged()).toBe(
        "pre-push origin x\n".repeat(3) + "pre-push backup x\n" + "pre-push origin x\n".repeat(4),
      );
    },
    limit(20_000),
  );
});

// Invented stand-ins for the names h&w never shows: QZX three letters in capitals, ZWOX four, Brennwald a
// capitalised name with a legal form, Marigold a dictionary word the public text also carries.
describe("check-confidential never", () => {
  const dir = temp();
  writeFileSync(join(dir, "never.txt"), "QZX\nBrennwald AG\nMarigold\nZWOX\n");
  writeFileSync(join(dir, "public.txt"), "We like Marigold.\n");
  const build = (input: string, never = join(dir, "never.txt")) =>
    run(
      dir,
      "check-confidential",
      ["build", "-", "--public", join(dir, "public.txt"), "--never", never],
      {},
      input,
    );
  const list = join(dir, "list.json");
  writeFileSync(list, build("Acme Widgets\nMarigold\n").out);
  const env = { SCAFFOLDING_CONFIDENTIAL_TERMS: list, CI: "" };
  // The never scan reads the working tree's package.json and needs no commit.
  const plain = repo({ "package.json": "{}" }, false);
  const never = (texts: unknown, at = plain, extra = {}) =>
    run(at, "check-confidential", ["never"], { ...env, ...extra }, JSON.stringify(texts));
  const listWith = (section?: unknown) => {
    const file = join(temp(), "list.json");
    writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(readFileSync(list, "utf8")), never: section }),
    );
    return file;
  };

  test("build keeps every never name, hashed, and a cased one also in any case", () => {
    const built = jsonObject(readFileSync(list));
    expect(readFileSync(list, "utf8")).not.toMatch(/qzx|zwox|brennwald|marigold/i);
    // Marigold, public and a word, leaves the terms but stays a never name.
    expect(built.hashes).toHaveLength(1);
    // QZX and ZWOX two each, Brennwald AG and Brennwald one each, Marigold only its "any:" one.
    expect(built.never).toHaveLength(7);
  });

  test("build refuses an empty never input and a name under three letters, its legal form dropped", () => {
    const names = join(dir, "names.txt");
    for (const [text, why] of [
      ["\n\n", "--never: no name"],
      ["QZX\nQZ\n", "under three letters: QZ"],
      ["QZ AG\n", "under three letters: QZ AG"],
      ["Q 7\n", "under three letters: Q 7"],
    ]) {
      writeFileSync(names, text);
      const r = build("Acme Widgets\n", names);
      expect(r.code).toBe(1);
      expect(r.out).toContain(why);
    }
    const bare = run(dir, "check-confidential", ["build", "-", "--never"], {}, "Acme Widgets\n");
    expect(bare.code).toBe(1);
    expect(bare.out).toContain("--never: no name");
    writeFileSync(names, "QZX AG\n");
    expect(build("Acme Widgets\n", names).code).toBe(0);
  });

  test("build reads the never names from stdin after a NUL byte; without one it refuses", () => {
    const both = ["build", "-", "--never", "-"];
    const r = run(dir, "check-confidential", both, {}, "Acme Widgets\nZWOX\n\0QZX\nBrennwald AG\n");
    expect(r.code).toBe(0);
    // ZWOX before the NUL is a term: QZX two hashes, Brennwald AG and Brennwald one each.
    expect(jsonObject(r.out).hashes).toHaveLength(2);
    expect(jsonObject(r.out).never).toHaveLength(4);
    const none = run(dir, "check-confidential", both, {}, "Acme Widgets\nQZX\n");
    expect(none.code).toBe(1);
    expect(none.out).toContain("--never: no name");
  });

  // The matching table of the never-shown names report, each name replaced by its stand-in.
  test.each([
    ["QZX", true],
    ["Qzx", true],
    ["qzx", true],
    ["QZX-Lieferung", true],
    ["QZX’s Team", true],
    ["qzx-workshop", true],
    ["/qzx-ops-training/a.svg", true],
    ["Qzx-Wan Keqzx", true],
    ["Brennwald", true],
    ["BRENNWALD", true],
    ["Brennwald-Projekt", true],
    ["QZX Smart Systems", true],
    ["Marigold", true],
    ["marigold", true],
    ["zwox", true],
    ["Brennwalds", false],
    ["Wir haben gestern im Büro über das Angebot gesprochen.", false],
  ])("%s: refused %p", (text, refused) => {
    const r = never({ "deck/a": "Titel\n" + text });
    expect(r.code).toBe(refused ? 1 : 0);
    if (refused) expect(r.out).toContain("deck/a: a name h&w never shows from the company records");
  });

  test("a key counts as text: a slug can show the name", () => {
    expect(never({ "clients/qzx-workshop": "Agenda" }).out).toContain("(qzx)");
  });

  test("runs in a private repository too", () => {
    const at = repo({ "package.json": JSON.stringify({ scaffolding: { private: true } }) });
    expect(never({ x: "QZX" }, at).code).toBe(1);
  });

  test("an allow entry in the working tree's package.json passes its case; one matching nothing fails", () => {
    const entry = {
      check: "never-shown",
      path: "deliveries/*-qzx-*/*",
      text: "QZX",
      reason: "its own client",
    };
    const at = repo({ "package.json": "{}" });
    write(at, { "package.json": JSON.stringify({ scaffolding: { allow: [entry] } }) });
    expect(never({ "deliveries/2026-qzx-a/deck": "QZX" }, at).code).toBe(0);
    // The entry covers its text only: another never name in the same delivery still refuses.
    expect(never({ "deliveries/2026-qzx-a/deck": "QZX and Brennwald" }, at).code).toBe(1);
    const stale = never({ "deliveries/2026-other/deck": "nothing" }, at);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain("allow entry matches nothing");
    // A confidential entry is the public scans' own and covers no never name.
    write(at, {
      "package.json": JSON.stringify({
        scaffolding: { allow: [{ ...entry, check: "confidential" }] },
      }),
    });
    expect(never({ "deliveries/2026-qzx-a/deck": "QZX" }, at).code).toBe(1);
  });

  test("a value nests: every key and string in it is scanned", () => {
    expect(never({ deck: { slides: [{ title: "plain", notes: ["QZX"] }] } }).code).toBe(1);
    expect(never({ deck: { slides: [{ QZX: 1 }] } }).code).toBe(1);
    expect(never({ deck: { slides: [{ title: "plain", notes: ["text"] }] } }).code).toBe(0);
    // Each string is scanned apart: two of them never join into a name neither shows.
    expect(never({ deck: ["met Brennwald", "AG today"] }).out).not.toContain("(Brennwald AG)");
    expect(never({ deck: ["met Brennwald AG today"] }).out).toContain("(Brennwald AG)");
    // A name in several strings of one value is one finding.
    expect(never({ deck: ["QZX here", "QZX there"] }).out).toContain("1 findings");
  });

  test("an input that is empty, not JSON, not an object or holds a value with neither a string nor a key refuses, past any allow entry", () => {
    const at = repo({
      "package.json": JSON.stringify({
        scaffolding: { allow: [{ check: "never-shown", reason: "everything" }] },
      }),
    });
    for (const input of [
      "",
      "{}",
      "[]",
      "not json",
      '{"a": "x", "b": 1}',
      '{"a": [{}]}',
      '"QZX"',
    ]) {
      const r = run(at, "check-confidential", ["never"], env, input);
      expect(r.code).toBe(1);
      expect(r.out).toContain("stdin: nothing to scan");
    }
    expect(never({ a: "plain text" }).code).toBe(0);
  });

  test("a list with a missing or empty never section refuses", () => {
    for (const section of [undefined, []]) {
      const r = never({ a: "plain text" }, plain, {
        SCAFFOLDING_CONFIDENTIAL_TERMS: listWith(section),
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain("the list has no never section");
    }
  });

  test("CI skips with a warning", () => {
    const r = never({ a: "QZX" }, plain, { CI: "true" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("CI: never scan skipped");
  });

  test("a public commit and its message refuse never names under the commit scan's casing rule", () => {
    const at = repo({ "package.json": "{}", "a.md": "a\n" });
    const staged = (text: string, terms = list) => {
      write(at, { "a.md": `a\n${text}\n` });
      sh(at, ["add", "a.md"]);
      return run(at, "check-confidential", ["--staged"], {
        ...env,
        SCAFFOLDING_CONFIDENTIAL_TERMS: terms,
      }).code;
    };
    for (const text of ["QZX", "see qzx-workshop/", "ZWOX", "Brennwald", "brennwald"])
      expect([text, staged(text)]).toEqual([text, 1]);
    // A dictionary word on the never list refuses no ordinary text in public.
    for (const text of ["bei Qzx", "zwox", "Zwox", "a marigold", "Marigold"])
      expect([text, staged(text)]).toEqual([text, 0]);
    // A list without a never section scans as before.
    const old = listWith(undefined);
    expect(staged("QZX Brennwald", old)).toBe(0);
    expect(staged("Acme Widgets", old)).toBe(1);
    const msg = join(at, "MSG");
    writeFileSync(msg, "fix: deck for Brennwald\n");
    expect(run(at, "check-confidential", ["--message-file", msg], env).code).toBe(1);
  });
});

describe("check-confidential list source", () => {
  const names = join(temp(), "names.txt");
  writeFileSync(names, "Acme Widgets GmbH\n");
  const fresh = run(temp(), "check-confidential", ["build", names]).out;
  const builtDaysAgo = (days: number, list = fresh) =>
    JSON.stringify({
      ...JSON.parse(list),
      built: new Date(Date.now() - days * 864e5).toISOString(),
    });
  const stubDir = temp();
  writeFileSync(
    join(stubDir, "gh"),
    '#!/bin/sh\necho "$*" >> "$GH_STUB_LOG"\n[ "$GH_STUB" = ok ] && exec cat "$GH_STUB_FILE"\necho "HTTP 404: Not Found" >&2\nexit 1\n',
    { mode: 0o755 },
  );

  function machine(opts: {
    gh: "ok" | "deny";
    remote?: string;
    cache?: string;
    cacheDays?: number;
  }) {
    const home = temp();
    const remote = join(home, "remote.json");
    writeFileSync(remote, opts.remote ?? fresh);
    const dir = repo({ "package.json": "{}", "a.md": "a\n" });
    const cache = join(dir, "node_modules/.cache/scaffolding/confidential-terms.json");
    if (opts.cache) {
      write(dir, { "node_modules/.cache/scaffolding/confidential-terms.json": opts.cache });
      const t = (Date.now() - (opts.cacheDays ?? 0) * 864e5) / 1000;
      utimesSync(cache, t, t);
    }
    const log = join(home, "gh.log");
    writeFileSync(log, "");
    write(dir, { "a.md": "a\nA visit to Acme Widgets.\n" });
    sh(dir, ["add", "a.md"]);
    const env = {
      HOME: home,
      PATH: `${stubDir}:${process.env.PATH}`,
      GH_STUB: opts.gh,
      GH_STUB_FILE: remote,
      GH_STUB_LOG: log,
      CI: "",
      SCAFFOLDING_CONFIDENTIAL_TERMS: "",
    };
    const check = (extra: Record<string, string> = {}, args = ["--staged"], input?: string) =>
      run(dir, "check-confidential", args, { ...env, ...extra }, input);
    const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    return { dir, home, check, calls, cache };
  }

  test("fresh machine with access: fetches, caches and finds the term", () => {
    const m = machine({ gh: "ok" });
    const r = m.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("(Acme Widgets)");
    expect(m.calls()).toBe(1);
    expect(readFileSync(m.cache, "utf8")).toBe(fresh);
    // Bun's own transpiler cache may land in HOME; the command writes nothing there.
    expect(readdirSync(m.home)).not.toContain(".config");
    expect(readdirSync(m.home)).not.toContain(".cache");
  });

  test("the never scan fetches, keeps and ages the list as the commit scan does", () => {
    const neverNames = join(temp(), "never.txt");
    writeFileSync(neverNames, "QZX\n");
    const withNever = run(temp(), "check-confidential", [
      "build",
      names,
      "--never",
      neverNames,
    ]).out;
    const deck = JSON.stringify({ a: "QZX" });
    const m = machine({ gh: "ok", remote: withNever });
    expect(m.check({}, ["never"], deck).out).toContain("(QZX)");
    expect(readFileSync(m.cache, "utf8")).toBe(withNever);
    m.check({}, ["never"], deck);
    expect(m.calls()).toBe(1);
    const r = machine({ gh: "ok", remote: builtDaysAgo(10, withNever) }).check({}, ["never"], deck);
    expect(r.code).toBe(1);
    expect(r.out).toContain("list built 10 days ago, more than 7");
    expect(r.out).toContain("then run it again");
    // A copy fetched before Company OS built the section is fetched again, at most hourly.
    const before = machine({ gh: "ok", remote: withNever, cache: fresh, cacheDays: 0.5 });
    expect(before.check({}, ["never"], deck).out).toContain("(QZX)");
    expect(before.calls()).toBe(1);
    const denied = machine({ gh: "deny", cache: fresh, cacheDays: 0.5 });
    expect(denied.check({}, ["never"], deck).out).toContain("the list has no never section");
    expect(denied.check({}, ["never"], deck).out).toContain("copy without a never section");
    expect(denied.calls()).toBe(1);
  });

  test("a copy fetched within the day is used without a fetch", () => {
    const m = machine({ gh: "deny", cache: fresh, cacheDays: 0.5 });
    expect(m.check().out).toContain("(Acme Widgets)");
    expect(m.calls()).toBe(0);
  });

  test("a stale copy within 7 days is used with a warning, retried at most hourly", () => {
    const m = machine({ gh: "deny", cache: builtDaysAgo(2), cacheDays: 2 });
    const first = m.check();
    expect(first.out).toContain("using the copy fetched before");
    expect(first.out).toContain("(Acme Widgets)");
    expect(first.out).not.toContain("Refused");
    expect(m.calls()).toBe(1);
    expect(m.check().out).toContain("next fetch within the hour");
    expect(m.calls()).toBe(1);
  });

  test("a stale copy is replaced when the fetch works", () => {
    const m = machine({ gh: "ok", cache: builtDaysAgo(2), cacheDays: 2 });
    m.check();
    expect(m.calls()).toBe(1);
    expect(readFileSync(m.cache, "utf8")).toBe(fresh);
  });

  test("a list built more than 7 days ago refuses, even freshly fetched", () => {
    const m = machine({ gh: "ok", remote: builtDaysAgo(10) });
    const r = m.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("list built 10 days ago, more than 7");
    expect(r.out).toContain("gh auth login");
  });

  test("no access and no copy refuses the commit, even for text without a term", () => {
    const m = machine({ gh: "deny" });
    write(m.dir, { "a.md": "a\nnothing confidential\n" });
    sh(m.dir, ["add", "a.md"]);
    const r = m.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("HTTP 404");
    expect(r.out).toContain("Refused");
  });

  test("--list-optional passes without any list, never with a stale one or past a term", () => {
    const optional = ["--staged", "--list-optional"];
    const none = machine({ gh: "deny" });
    expect(none.check().code).toBe(1);
    const r = none.check({}, optional);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--list-optional: terms not scanned");
    expect(
      machine({ gh: "deny", cache: builtDaysAgo(10), cacheDays: 2 }).check({}, optional).code,
    ).toBe(1);
    expect(machine({ gh: "ok" }).check({}, optional).out).toContain("(Acme Widgets)");
    // An audit never goes without the list.
    expect(none.check({}, ["--index", "--list-optional"]).code).toBe(1);
  });

  test("--list-optional without a list passes a file this machine cannot read, never with a list", () => {
    const optional = ["--staged", "--list-optional"];
    const none = machine({ gh: "deny" });
    // A machine whose swiftc fails: no OCR, as off macOS.
    const noOcr = temp();
    writeFileSync(join(noOcr, "swiftc"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    write(none.dir, { "a.md": "a\n", "talk.pdf": "%PDF-1.4" });
    writeFileSync(join(none.dir, "shot.png"), PNG);
    sh(none.dir, ["add", "a.md", "shot.png", "talk.pdf"]);
    const PATH = `${noOcr}:${stubDir}:/usr/bin:/bin`;
    const r = none.check({ PATH }, optional);
    expect(r.code).toBe(0);
    expect(r.out).toContain("shot.png: image not read");
    expect(r.out).toContain("talk.pdf: PDF not read");
    expect(r.out).toContain("--list-optional: passed unread");
    // Passed unread is not read: a later scan with the list still refuses it.
    const list = join(none.home, "list.json");
    writeFileSync(list, fresh);
    const strict = none.check({ PATH, SCAFFOLDING_CONFIDENTIAL_TERMS: list }, optional);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain("shot.png: image not read");
    // A stale list refuses, and the unread file is reported, not passed.
    const stale = machine({ gh: "deny", cache: builtDaysAgo(10), cacheDays: 2 });
    writeFileSync(join(stale.dir, "shot.png"), PNG);
    sh(stale.dir, ["add", "shot.png"]);
    expect(stale.check({ PATH }, optional).out).not.toContain("passed unread");
  });

  test("--list-optional without a copy tries gh at most hourly; without it every commit tries", () => {
    const m = machine({ gh: "deny" });
    expect(m.check({}, ["--staged", "--list-optional"]).code).toBe(0);
    const again = m.check({}, ["--staged", "--list-optional"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("next fetch within the hour");
    expect(m.calls()).toBe(1);
    expect(m.check().code).toBe(1);
    expect(m.calls()).toBe(2);
    const attempt = `${m.cache}.attempt`;
    const hourAgo = (Date.now() - 3_700_000) / 1000;
    utimesSync(attempt, hourAgo, hourAgo);
    m.check({}, ["--staged", "--list-optional"]);
    expect(m.calls()).toBe(3);
  });

  test("CI skips the audit's term step without fetching, the path rule still holds", () => {
    const m = machine({ gh: "deny" });
    expect(m.check({ CI: "true" }, ["--index"]).code).toBe(0);
    expect(m.calls()).toBe(0);
    write(m.dir, { "docs/agent-work/shot.png": "x" });
    sh(m.dir, ["add", "docs/agent-work/shot.png"]);
    expect(m.check({ CI: "true" }, ["--index"]).out).toContain(
      "docs/agent-work/shot.png: binary file in docs/agent-work not read: no OCR in CI",
    );
  });

  test("a PDF that cannot be read is refused", () => {
    const m = machine({ gh: "ok" });
    write(m.dir, { "a.md": "a\n", "talk.pdf": "%PDF-1.4" });
    sh(m.dir, ["add", "a.md", "talk.pdf"]);
    const r = m.check({ PATH: `${stubDir}:/usr/bin:/bin` });
    expect(r.out).toContain("talk.pdf: PDF not read");
    expect(r.code).toBe(1);
  });
});

const markdownRepair =
  "Run bun run scaffolding markdown --fix to apply markdownlint's fixes. Repair remaining findings in the file by changing only Markdown structure and preserving every word.";
const shellRepair = "Repair each ShellCheck finding in the script.";

describe("scaffolding check", () => {
  const gate = (scaffolding: object, scripts: Record<string, string> = {}, extra: object = {}) =>
    repo({
      "package.json": JSON.stringify({
        name: "fx",
        type: "module",
        scripts,
        scaffolding,
        ...extra,
      }),
    });
  // Every shared step skipped, so only the runner's own logic is under test.
  const all = {
    format: "t",
    lint: "t",
    styles: "t",
    typecheck: "t",
    structure: "t",
    coupling: "t",
    cycles: "t",
    shell: "t",
    markdown: "t",
  };
  const skip = {
    ...all,
    confidential: "t",
    licenses: "t",
    test: "t",
    catalog: "t",
    admin: "t",
  };

  test("an allow entry naming a check that reads no allow list fails", () => {
    const entry = (check: string) => ({ allow: [{ check, path: "a.ts", reason: "r" }] });
    const lock = { CHECK_LOCK: join(temp(), "lock") };
    const left = run(gate({ skip, ...entry("unique-names") }), "scaffolding", ["check"], lock);
    expect(left.out).toContain("scaffolding.allow names no check that reads it: unique-names");
    expect(left.code).toBe(1);
    // Control: a check that reads it.
    expect(
      run(gate({ skip, ...entry("spaces") }), "scaffolding", ["check"], lock).out,
    ).not.toContain("names no check");
  });

  test("a runtime import cycle fails the gate under the step's name", () => {
    const { cycles: _c, ...rest } = skip;
    const dir = gate({ skip: rest });
    write(dir, {
      "a.ts": 'import { b } from "./b.ts";\nexport const a = (): number => b();\n',
      "b.ts": 'import { a } from "./a.ts";\nexport const b = (): number => a();\n',
    });
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/failed in [\d.]+ s: cycles/);
  });

  test("a tracked Markdown finding fails the gate under the step's name", () => {
    const { markdown: _m, ...rest } = skip;
    const dir = gate({ skip: rest });
    write(dir, { "record.md": "Body without a title.\n" });
    expect(sh(dir, ["add", "--", "record.md"]).status).toBe(0);
    const env = { CHECK_LOCK: join(dir, ".lock") };
    const r = run(dir, "scaffolding", ["check"], env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("record.md:1 error MD041");
    expect(r.out).toMatch(/failed in [\d.]+ s: markdown/);
    expect(r.out.split("\n").filter((line) => line === markdownRepair)).toEqual([markdownRepair]);
    write(dir, { "record.md": "# Body without a title.\n" });
    const green = run(dir, "scaffolding", ["check"], env);
    expect(green.code).toBe(0);
    expect(green.out).not.toContain(markdownRepair);
  });

  test("a tracked shell finding fails the gate under the step's name", () => {
    const { shell: _s, ...rest } = skip;
    const dir = gate({ skip: rest });
    write(dir, { "script.sh": shellScript });
    expect(sh(dir, ["add", "--", "script.sh"]).status).toBe(0);
    const env = {
      CHECK_LOCK: join(dir, ".lock"),
      ...shellcheckFixture(dir),
    };
    const r = run(dir, "scaffolding", ["check"], env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("SC2034");
    expect(r.out).toMatch(/failed in [\d.]+ s: shell/);
    expect(r.out.split("\n").filter((line) => line === shellRepair)).toEqual([shellRepair]);
    write(dir, { "script.sh": "#!/bin/sh\necho ready\n" });
    const green = run(dir, "scaffolding", ["check"], env);
    expect(green.code).toBe(0);
    expect(green.out).not.toContain(shellRepair);
  });

  test("lint waits for a typecheck that runs Astro, whose content types it reads", () => {
    const { lint: _l, typecheck: _t, ...rest } = skip;
    // `bun --bun <name>` runs a script of that name: the stand-ins for astro check and eslint.
    const dir = gate(
      { skip: rest, typecheck: "typecheck" },
      { typecheck: "sleep 0.5; echo astro > synced.txt", eslint: "test -f synced.txt #" },
    );
    install(dir);
    write(dir, { ".oxlintrc.json": JSON.stringify(oxlintTemplate) });
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.out).toContain("ok   lint");
    expect(r.out).toContain("ok   oxlint");
    expect(r.code).toBe(0);
  });

  test("runs the repository's steps in order and passes", () => {
    const dir = gate({ skip, check: ["mine", ["true", "true"]] }, { mine: "echo ran-mine" });
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(0);
    expect(r.out).toContain("ran-mine");
    expect(r.out).toContain("passed");
  });

  test("format, lint, oxlint and styles walk past a submodule, which its own repository checks", () => {
    const { format: _f, lint: _l, styles: _s, ...rest } = skip;
    const inner = repo({
      "bad.js": "const   unusedThing=1\n",
      "bad.css": "a{color:red}\n",
    });
    const dir = gate({ skip: { ...rest, spaces: "t" } });
    sh(dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "vendor/inner"]);
    const pkg = readPackage(dir);
    write(dir, {
      ".oxlintrc.json": readFileSync(
        join(import.meta.dirname, "../template/.oxlintrc.json"),
        "utf8",
      ),
      "package.json": `${JSON.stringify({ ...pkg, prettier: join(import.meta.dirname, "../config/prettier.js") }, null, 2)}\n`,
      "eslint.config.js": `export { default } from "${join(import.meta.dirname, "..", "config", "eslint.js")}";\n`,
      "stylelint.config.js": 'export default { rules: { "color-named": "never" } };\n',
      "ok.css": "a {\n  color: #f00;\n}\n",
    });
    install(dir);
    symlinkSync(join(import.meta.dirname, "../node_modules/.bin"), join(dir, "node_modules/.bin"));
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.out).not.toContain("vendor/inner");
    expect(r.code, r.out).toBe(0);
  });

  test("no step sees a variable only .env set, a nested bun included", () => {
    const probe = `sh -c 'echo sh=\${SCAF_TEST_SECRET:-none}' && bun probe.ts && echo options=[$BUN_OPTIONS]`;
    const dir = gate({ skip, check: ["check:probe"] }, { "check:probe": probe });
    write(dir, {
      ".env": "SCAF_TEST_SECRET=x\n",
      "probe.ts": 'console.log(`bun=${process.env.SCAF_TEST_SECRET ?? "none"}`);\n',
    });
    // The parent gate hands its own BUN_OPTIONS down; each run here starts without it.
    const { BUN_OPTIONS: _, ...bare } = process.env;
    const env = { ...bare, CHECK_LOCK: join(dir, ".lock") };
    const plain = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: dir, env, encoding: "utf8" });
    // Control: outside the gate, bun loads .env.
    expect(plain(process.execPath, ["probe.ts"]).stdout).toContain("bun=x");
    for (const r of [
      plain(process.execPath, ["--no-env-file", bin("scaffolding"), "check"]),
      plain(bin("scaffolding"), ["check"]),
      // No `env -S`: BusyBox `env`, as on Alpine, refuses it.
      plain("/bin/sh", [bin("scaffolding"), "check"]),
    ]) {
      const out = `${r.stdout}${r.stderr}`;
      expect(out).toContain("sh=none");
      expect(out).toContain("bun=none");
      // Once, though the gate re-runs itself under check-lock.
      expect(out).toContain("options=[--no-env-file]\n");
      expect(r.status).toBe(0);
    }
    for (const name of ["scaffolding", "check-staged"]) {
      const loaded = plain(process.execPath, [bin(name), "check"]);
      expect(loaded.status).toBe(2);
      expect(loaded.stderr).toContain("--no-env-file");
    }
  });

  test("--changed adds local mappings to the defaults and recognizes shared configuration", () => {
    const changed = { "docs/**": ["check:docs"], "src/**": ["check:src"] };
    const dir = gate(
      { skip, changed, check: [["check:docs", "check:src"]] },
      { "check:docs": "echo docs-ran", "check:src": "echo src-ran" },
    );
    // The lock outside the checkout: an untracked file there is a changed path.
    const lock = { CHECK_LOCK: join(temp(), "lock") };
    write(dir, { "docs/a.md": "a\n" });
    const mapped = run(dir, "scaffolding", ["check", "--changed"], lock);
    expect(mapped.out).toContain("docs-ran");
    expect(mapped.out).not.toContain("src-ran");
    expect(mapped.out).toContain("[scaffolding] skipped check:src: no changed path maps to it");
    expect(mapped.code).toBe(0);
    // A file every step reads runs every step too.
    write(dir, { "bunfig.toml": "\n" });
    expect(run(dir, "scaffolding", ["check", "--changed"], lock).out).toContain("src-ran");
  });

  test.each([
    ["docs/guide.md", "# Guide\n", "markdown", 'matches "docs/guide.md"'],
    ["scripts/.shellcheckrc", "# Defaults.\n", "shell", 'matches "scripts/.shellcheckrc"'],
    ["scripts/script.bash", "#!/bin/bash\ntrue\n", "shell", 'matches "scripts/script.bash"'],
    [
      "scripts/tool",
      "#!/usr/bin/env --split-string dash\ntrue\n",
      "shell",
      'matches shell shebang in "scripts/tool"',
    ],
  ])("--changed selects the matching linter for %s", (path, text, step, why) => {
    const { shell: _s, markdown: _m, ...rest } = skip;
    const dir = gate({ skip: rest });
    write(dir, { [path]: text });
    const r = run(dir, "scaffolding", ["check", "--changed"], { CHECK_LOCK: join(temp(), "lock") });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`selected ${step}: ${why}`);
    expect(r.out).toContain(
      `skipped ${step === "shell" ? "markdown" : "shell"}: no changed path maps to it`,
    );
  });

  test("--changed reads the removed shell shebang from the base of a pushed range", () => {
    const { shell: _s, markdown: _m, ...rest } = skip;
    const dir = gate({ skip: rest });
    write(dir, { "bin/tool": "#!/bin/ksh\ntrue\n" });
    expect(sh(dir, ["add", "--", "bin/tool"]).status).toBe(0);
    expect(sh(dir, ["commit", "-qm", "add script", "--", "bin/tool"]).status).toBe(0);
    const old = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
    expect(sh(dir, ["rm", "-q", "--", "bin/tool"]).status).toBe(0);
    expect(sh(dir, ["commit", "-qm", "remove script", "--", "bin/tool"]).status).toBe(0);
    const tip = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
    const r = run(dir, "scaffolding", ["check", "--changed", `${old}..${tip}`], {
      CHECK_LOCK: join(temp(), "lock"),
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('selected shell: matches shell shebang in "bin/tool"');
    expect(r.out).toContain("skipped markdown: no changed path maps to it");
  });

  test.each([
    ["template/.githooks/pre-push", "#!/bin/sh\ntrue\n", []],
    ["template/guide.md", "# Guide\n", []],
    ["template/.githooks/pre-push", "#!/bin/sh\ntrue\n", ["shell"]],
    ["template/guide.md", "# Guide\n", ["markdown"]],
    ["template/guide.md", "# Guide\n", ["shell", "markdown"]],
  ] as const)("--changed preserves tests for %s (%#)", (path, contents, skipped) => {
    const { shell: _s, markdown: _m, test: _t, ...rest } = skip;
    const dir = gate(
      {
        skip: { ...rest, ...Object.fromEntries(skipped.map((step) => [step, "fixture"])) },
        test: "probe",
      },
      { probe: "echo tests-ran" },
    );
    const old = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
    write(dir, { [path]: contents });
    expect(sh(dir, ["add", "--", path]).status).toBe(0);
    expect(sh(dir, ["commit", "-qm", "change one file", "--", path]).status).toBe(0);
    const r = run(dir, "scaffolding", ["check", "--changed", `${old}..HEAD`], {
      CHECK_LOCK: join(temp(), "lock"),
      ...shellcheckFixture(dir),
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("tests-ran");
    for (const step of skipped) expect(r.out).toContain(`skipped ${step}: fixture`);
  });

  test.each([
    [{ changed: { "docs/**": "check:docs" } }, "is no list of steps"],
    [{ changed: { "docs/**": [] } }, "is an empty list of steps"],
    [{ changed: { "docs/**": ["check:dosc"] } }, "names no step: check:dosc"],
    [{ changed: { "docs/{md": ["check:docs"] } }, "is no repository-relative glob"],
    [{ fullOnly: { "check:typo": "builds output" } }, "names no eligible step: check:typo"],
    [{ fullOnly: { "check:docs": " " } }, "scaffolding.fullOnly.check:docs has no reason"],
  ])("validates path mappings and full-only declarations in both modes (%j)", (config, message) => {
    const dir = gate({ skip, check: ["check:docs"], ...config });
    const lock = { CHECK_LOCK: join(temp(), "lock") };
    for (const args of [["check"], ["check", "--changed"]]) {
      const result = run(dir, "scaffolding", args, lock);
      expect(result.out).toContain(message);
      expect(result.code).toBe(1);
    }
  });

  test("--changed runs unscoped local checks on rules and skill prose", () => {
    const lock = { CHECK_LOCK: join(temp(), "lock") };
    const steps = { check: ["check:src"] };
    const scripts = { "check:src": "echo src-ran" };
    const bare = gate({ skip, ...steps }, scripts);
    write(bare, {
      ".claude/rules/r.md": "r\n",
      ".claude/skills/s/SKILL.md": "s\n",
      ".claude/skills/s/agents/a.yaml": "a\n",
    });
    const quick = run(bare, "scaffolding", ["check", "--changed"], lock);
    expect(quick.out).toContain("selected check:src: no path scope configured");
    expect(quick.out).toContain("src-ran");
    expect(quick.code).toBe(0);
    // Skill data outside the default map falls back to the fast gate.
    write(bare, { ".claude/skills/s/x.json": "{}\n" });
    expect(run(bare, "scaffolding", ["check", "--changed"], lock).out).toContain(
      '".claude/skills/s/x.json" matches no path glob: all fast steps run',
    );
    const own = gate({ skip, ...steps, changed: { ".claude/**": ["check:src"] } }, scripts);
    write(own, { ".claude/rules/r.md": "r\n" });
    expect(run(own, "scaffolding", ["check", "--changed"], lock).out).toContain(
      'selected check:src: matches ".claude/rules/r.md"',
    );
  });

  test(
    "--changed selects shared steps across pushed ranges and defers builds",
    () => {
      const { lint: _lint, typecheck: _typecheck, test: _test, catalog: _catalog, ...rest } = skip;
      const dir = gate(
        {
          skip: rest,
          typecheck: "typecheck",
          test: "test",
          check: ["check:preview"],
          changed: { "docs/**": ["check:preview"], "docs/lint.md": ["lint"] },
          fullOnly: { "check:preview": "builds a preview" },
        },
        {
          eslint: "test -f synced.txt && echo lint-ran #",
          typecheck: "sleep 0.1; echo astro > synced.txt",
          test: "echo test-ran",
          build: "echo catalog-ran",
          "check:preview": "echo preview-ran",
        },
      );
      install(dir);
      write(dir, {
        ".oxlintrc.json": JSON.stringify(oxlintTemplate),
        "tsconfig.json": '{"include":["src/**/*.ts"]}',
      });
      const lock = { CHECK_LOCK: join(temp(), "lock") };
      const git = (...args: string[]) => {
        const result = sh(dir, args);
        expect(result.status, result.stderr.toString()).toBe(0);
        return result.stdout.toString().trim();
      };
      const commit = (...paths: string[]) => {
        git("add", "--", ...paths);
        git("commit", "-qm", "fixture", "--", ...paths);
        return git("rev-parse", "HEAD");
      };
      const base = git("rev-parse", "HEAD");
      write(dir, { "docs/a.md": "a\n" });
      const docs = commit("docs/a.md");
      const docsRange = `${base}..${docs}`;
      const changed = (...ranges: string[]) => {
        const result = run(dir, "scaffolding", ["check", "--changed", ...ranges], lock);
        expect(result.code, result.out).toBe(0);
        expect(result.out).toContain("deferred catalog: builds the catalog");
        expect(result.out).toContain("deferred check:preview: builds a preview");
        expect(result.out).not.toMatch(/(?:catalog|preview)-ran/);
        return result.out;
      };
      const prose = changed(docsRange);
      expect(prose).toContain("skipped lint: no changed path maps to it");
      expect(prose).toContain("skipped test: no changed path maps to it");
      expect(prose).not.toMatch(/(?:lint|test)-ran/);

      write(dir, { "docs/lint.md": "lint\n" });
      const lint = commit("docs/lint.md");
      const lintOnly = changed(`${docs}..${lint}`);
      expect(lintOnly).toContain("selected typecheck: Astro lint needs generated types");
      expect(lintOnly).toContain("lint-ran");
      expect(lintOnly).not.toContain("test-ran");

      write(dir, { "src/a.ts": "export {};\n", "src/b.ts": "export {};\n" });
      const source = commit("src/a.ts", "src/b.ts");
      const union = changed(docsRange, `${lint}..${source}`);
      expect(union).toContain("3 paths since");
      expect(union).toContain("lint-ran");
      expect(union).toContain("test-ran");

      git("mv", "src/a.ts", "docs/renamed.md");
      git("commit", "-qm", "rename fixture", "--", "src/a.ts", "docs/renamed.md");
      const rename = git("rev-parse", "HEAD");
      const moved = changed(`${source}..${rename}`);
      expect(moved).toContain("2 paths since");
      expect(moved).toContain('selected lint: matches "src/a.ts"');
      renameSync(join(dir, "src/b.ts"), join(dir, "node_modules/deleted.ts"));
      const deleted = commit("src/b.ts");
      expect(changed(`${rename}..${deleted}`)).toContain('selected test: matches "src/b.ts"');

      write(dir, { "docs/yarn.lock": "" });
      const lockfile = commit("docs/yarn.lock");
      const configFallback = changed(`${deleted}..${lockfile}`);
      expect(configFallback).toContain("is a shared configuration path");
      expect(configFallback).toContain("test-ran");
      expect(changed(`${"0".repeat(40)}..${docs}`)).toContain("starts a new branch");
      expect(changed(`${"1".repeat(40)}..${docs}`)).toContain(
        "starts at a commit this clone lacks",
      );
      expect(changed(`${source}..${docs}`)).toContain("is not a verifiable fast-forward");

      const pkg = readPackage(dir);
      write(dir, {
        "package.json": JSON.stringify({
          ...pkg,
          scaffolding: {
            ...pkg.scaffolding,
            fullOnly: { ...pkg.scaffolding?.fullOnly, test: "launches Chrome" },
          },
        }),
      });
      const sourceWithMarkedTest = changed(`${lint}..${source}`);
      expect(sourceWithMarkedTest).toContain("deferred test: launches Chrome");
      expect(sourceWithMarkedTest).not.toContain("test-ran");
      const full = run(dir, "scaffolding", ["check"], lock);
      expect(full.code, full.out).toBe(0);
      expect(full.out).toContain("test-ran");
      expect(full.out).toContain("catalog-ran");
      expect(full.out).toContain("preview-ran");
    },
    limit(20_000),
  );

  test(
    "a push runs --changed over each pushed range, and the whole gate for a new branch",
    () => {
      const remote = temp();
      sh(remote, ["init", "-q", "--bare"]);
      const dir = gate(
        {
          skip,
          changed: { "docs/**": ["check:docs"], "src/**": ["check:src"] },
          check: [["check:docs", "check:src"]],
        },
        {
          check: `bun --no-env-file ${JSON.stringify(bin("scaffolding"))} check`,
          // Keeps the refs it was handed, takes the hook's arguments, and passes.
          "check-confidential": "sh -c 'cat > \"$REFS_LOG\"' sh",
          "check:docs": "echo docs-ran",
          "check:src": "echo src-ran",
        },
      );
      mkdirSync(join(dir, "node_modules"));
      const refs = join(temp(), "refs");
      const env = {
        ...process.env,
        SCAFFOLDING_LOAD: "0",
        CHECK_LOCK: join(temp(), "lock"),
        REFS_LOG: refs,
      };
      const hooks = join(import.meta.dirname, "..", "template/.githooks");
      const commit = (cwd: string, files: Record<string, string>) => {
        write(cwd, files);
        sh(cwd, ["add", ...Object.keys(files)]);
        sh(cwd, ["commit", "-qm", "c"]);
      };
      const push = (cwd: string, ref: string) => {
        const r = spawnSync("git", ["-c", `core.hooksPath=${hooks}`, "push", "-q", remote, ref], {
          cwd,
          env,
          encoding: "utf8",
        });
        return { code: r.status, out: `${r.stdout}${r.stderr}` };
      };
      commit(dir, { "docs/a.md": "a\n" });
      const first = push(dir, "HEAD:refs/heads/main");
      expect(first.out).toContain("starts a new branch: all fast steps run");
      expect(first.out).toContain("src-ran");
      expect(first.code).toBe(0);
      // check-confidential got the refs git handed the hook, line for line.
      const head = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
      expect(readFileSync(refs, "utf8")).toBe(`HEAD ${head} refs/heads/main ${"0".repeat(40)}\n`);
      // Rules and skill prose run the quick steps alone, whatever else the working tree holds.
      commit(dir, { ".claude/rules/r.md": "r\n", ".claude/skills/s/SKILL.md": "s\n" });
      write(dir, { "other.txt": "another session's file\n" });
      const hub = push(dir, "HEAD:refs/heads/main");
      expect(hub.out).toContain("[scaffolding] skipped check:src: no changed path maps to it");
      expect(hub.out).toContain("[scaffolding] skipped check:docs: no changed path maps to it");
      expect(hub.code).toBe(0);
      // A mapped path runs its step.
      commit(dir, { "docs/b.md": "b\n" });
      const docs = push(dir, "HEAD:refs/heads/main");
      expect(docs.out).toContain("docs-ran");
      expect(docs.out).not.toContain("src-ran");
      // From a detached linked worktree, which has no upstream, the range is still the pushed one.
      const tree = join(temp(), "tree");
      sh(dir, ["worktree", "add", "-q", "--detach", tree]);
      mkdirSync(join(tree, "node_modules"));
      commit(tree, { "src/a.ts": "export {};\n" });
      const code = push(tree, "HEAD:refs/heads/main");
      expect(code.out).toContain('selected check:src: matches "src/a.ts"');
      expect(code.out).toContain("src-ran");
      commit(tree, { ".claude/rules/s.md": "s\n" });
      expect(push(tree, "HEAD:refs/heads/main").out).toContain("skipped check:src");
      // A remote tip this clone lacks runs all fast steps.
      const lacks = run(dir, "scaffolding", ["check", "--changed", `${"1".repeat(40)}..HEAD`], env);
      expect(lacks.out).toContain("starts at a commit this clone lacks: all fast steps run");
      // Control: a tag carries no branch, and the gate does not run.
      sh(dir, ["tag", "v1"]);
      const tag = push(dir, "refs/tags/v1");
      expect(tag.out).not.toContain("check:src");
      expect(tag.code).toBe(0);
    },
    limit(60_000),
  );

  // git hands a hook in a linked worktree GIT_DIR, and every git a test of the gate ran in its own
  // repository then wrote into the pushing one: config, refs and HEAD.
  test(
    "a push from a linked worktree runs the gate without git's GIT_DIR",
    () => {
      const remote = temp();
      sh(remote, ["init", "-q", "--bare"]);
      const dir = gate(
        { skip, check: ["check:env"] },
        {
          check: `bun --no-env-file ${JSON.stringify(bin("scaffolding"))} check`,
          "check-confidential": "sh -c 'cat > /dev/null' sh",
          "check:env": 'printf "%s" "${GIT_DIR-unset}" > "$ENV_LOG"',
        },
      );
      mkdirSync(join(dir, "node_modules"));
      sh(dir, ["add", "-A"]);
      sh(dir, ["commit", "-qm", "gate"]);
      const tree = join(temp(), "tree");
      sh(dir, ["worktree", "add", "-q", "--detach", tree]);
      mkdirSync(join(tree, "node_modules"));
      const log = join(temp(), "env");
      const hooks = join(import.meta.dirname, "..", "template/.githooks");
      const push = spawnSync(
        "git",
        ["-c", `core.hooksPath=${hooks}`, "push", "-q", remote, "HEAD:refs/heads/main"],
        {
          cwd: tree,
          env: {
            ...process.env,
            SCAFFOLDING_LOAD: "0",
            CHECK_LOCK: join(temp(), "lock"),
            ENV_LOG: log,
          },
          encoding: "utf8",
        },
      );
      expect(push.status).toBe(0);
      expect(readFileSync(log, "utf8")).toBe("unset");
    },
    limit(30_000),
  );

  test("a failing step fails the gate and stops the later ones", () => {
    const dir = gate({ skip, check: ["false", "echo never-ran"] });
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL false");
    expect(r.out).not.toContain("never-ran");
  });

  test("a step is reported when it ends, and the verdict names the red ones in order", () => {
    const dir = gate(
      { skip, check: [["check:slow", "check:fast", "check:also"]] },
      { "check:slow": "sleep 2; echo slow-done", "check:fast": "exit 1", "check:also": "exit 1" },
    );
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(1);
    expect(r.out.indexOf("FAIL check:fast")).toBeLessThan(r.out.indexOf("slow-done"));
    expect(r.out).toMatch(/\[scaffolding\] failed in [\d.]+ s: check:fast, check:also\n/);
  });

  test(
    "above one waiting process per core the repository's steps run a limited number at a time",
    () => {
      // Each step fails where three run at once.
      const body = (me: string) =>
        `touch ${me}.on; sleep 0.5; n=$(ls *.on | wc -l); rm ${me}.on; test $n -le 2`;
      const dir = gate(
        { skip, check: [["check:a", "check:b", "check:c", "check:limit"]] },
        {
          "check:a": body("a"),
          "check:b": body("b"),
          "check:c": body("c"),
          "check:limit": "echo limit=$SCAFFOLDING_TEST_TIMEOUT_MS",
        },
      );
      const loaded = run(dir, "scaffolding", ["check"], {
        CHECK_LOCK: join(dir, ".lock"),
        SCAFFOLDING_LOAD: "99999",
      });
      expect(loaded.out).toMatch(
        /load 99999 on \d+ cores: test and catalog run one after another, the repository's steps 2 at a time/,
      );
      expect(loaded.code).toBe(0);
      // The per-test limit a test command can pass on, stretched by load per core, ten times at most.
      expect(loaded.out).toContain("limit=50000");
      const idle = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
      expect(idle.out).not.toContain("at a time");
      expect(idle.out).toContain("limit=5000\n");
      expect(idle.code).toBe(1);
    },
    limit(40_000),
  );

  test(
    "a signal to the outer runner ends the steps, names them, and frees the lock",
    async () => {
      const dir = gate(
        { skip, check: [["check:fast", "check:slow"]] },
        { "check:fast": "echo fast-said; exit 1", "check:slow": "sleep 5; touch slow-done" },
      );
      const lock = join(dir, ".lock");
      const gateRun = Bun.spawn([process.execPath, "--no-env-file", bin("scaffolding"), "check"], {
        cwd: dir,
        env: { ...process.env, CHECK_LOCK: lock, SCAFFOLDING_LOAD: "0" },
        stderr: "pipe",
        stdout: "pipe",
      });
      for (const end = Date.now() + 20_000; !existsSync(lock) && Date.now() < end;)
        await Bun.sleep(50);
      await Bun.sleep(1_000);
      gateRun.kill("SIGTERM");
      const code = await gateRun.exited;
      const out = `${await new Response(gateRun.stdout).text()}${await new Response(gateRun.stderr).text()}`;
      expect(code).not.toBe(0);
      expect(out).toContain("fast-said");
      expect(out).toContain("FAIL check:fast");
      expect(out).toContain("stopped check:slow by SIGTERM");
      expect(existsSync(lock)).toBe(false);
      await Bun.sleep(5_000);
      expect(existsSync(join(dir, "slow-done"))).toBe(false);
    },
    limit(40_000),
  );

  test(
    "Ctrl-C, a SIGINT to the terminal's whole group, stops the steps once and names them",
    async () => {
      const dir = gate(
        { skip, check: [["check:fast", "check:slow"]] },
        { "check:fast": "echo fast-said; exit 1", "check:slow": "sleep 5; touch slow-done" },
      );
      const lock = join(dir, ".lock");
      // Its own group stands in for the terminal's foreground group.
      const gateRun = spawn(process.execPath, ["--no-env-file", bin("scaffolding"), "check"], {
        cwd: dir,
        env: { ...process.env, CHECK_LOCK: lock, SCAFFOLDING_LOAD: "0" },
        detached: true,
      });
      let out = "";
      gateRun.stdout.on("data", (d) => (out += d));
      gateRun.stderr.on("data", (d) => (out += d));
      for (const end = Date.now() + 20_000; !existsSync(lock) && Date.now() < end;)
        await Bun.sleep(50);
      await Bun.sleep(1_000);
      process.kill(-gateRun.pid!, "SIGINT");
      await new Promise((done) => gateRun.on("close", done));
      expect(out).toContain("stopped check:slow by SIGINT");
      expect(existsSync(lock)).toBe(false);
    },
    limit(40_000),
  );

  test("a repository pinning puppeteer-core gets Chrome installed once, before the steps", () => {
    const dir = gate(
      { skip, check: [["check:a", "check:b"]] },
      { "check:a": "cat calls.txt", "check:b": "cat calls.txt" },
    );
    write(dir, {
      "node_modules/puppeteer-core/internal/revisions.js":
        'exports.PUPPETEER_REVISIONS = { chrome: "1.2.3" };\n',
      "fake/bunx": '#!/bin/sh\necho "install $*" >> calls.txt\necho /nowhere/chrome\n',
    });
    chmodSync(join(dir, "fake/bunx"), 0o755);
    const r = run(dir, "scaffolding", ["check"], {
      CHECK_LOCK: join(dir, ".lock"),
      PATH: `${join(dir, "fake")}:${process.env.PATH}`,
      PUPPETEER_CACHE_DIR: join(dir, "cache"),
    });
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "calls.txt"), "utf8").match(/chrome@1\.2\.3/g)).toHaveLength(1);
  });

  test("a package path holding a space runs every bin step", () => {
    const home = join(temp(), "with space");
    for (const folder of ["bin", "lib", "config", "template/.githooks"])
      cpSync(join(import.meta.dirname, "..", folder), join(home, folder), { recursive: true });
    const dir = gate({ skip });
    const r = spawnSync(
      process.execPath,
      ["--no-env-file", join(home, "bin/scaffolding.ts"), "check"],
      {
        cwd: dir,
        env: { ...process.env, CHECK_LOCK: join(dir, ".lock"), SCAFFOLDING_LOAD: "0" },
        encoding: "utf8",
      },
    );
    expect(`${r.stdout}${r.stderr}`).toContain("ok   spaces");
    expect(r.status).toBe(0);
  });

  test("a gate pinning brand needs retired inputs, a local check, or a skip reason", () => {
    // A local pin: a github: one downloads brand on every install the gate runs.
    const pin = { devDependencies: { "@hackersandwizards/brand": "file:brand" } };
    const branded = (scaffolding: object, scripts: Record<string, string> = {}) => {
      const dir = gate(scaffolding, scripts, pin);
      write(dir, { "brand/package.json": '{"name":"@hackersandwizards/brand","version":"1.0.0"}' });
      return dir;
    };
    const lock = (d: string) => ({ CHECK_LOCK: join(d, ".lock") });
    const noScans = { ...skip, colours: "fixture", copies: "fixture", elements: "fixture" };
    const bare = branded({ skip: noScans });
    const r = run(bare, "scaffolding", ["check"], lock(bare));
    expect(r.code).toBe(1);
    expect(r.out).toContain("declare scaffolding.brand.retired");
    const listed = branded(
      { skip: noScans, check: [["check:retired", "true"]] },
      { "check:retired": "echo ran-retired" },
    );
    const ok = run(listed, "scaffolding", ["check"], lock(listed));
    expect(ok.out).toContain("ran-retired");
    expect(ok.out).toContain("retired uses local check:retired");
    expect(ok.code).toBe(0);
    const skipped = branded({ skip: { ...noScans, retired: "brand only in tests" } });
    expect(run(skipped, "scaffolding", ["check"], lock(skipped)).code).toBe(0);
    const blank = branded({ skip: { ...noScans, retired: " " } });
    expect(run(blank, "scaffolding", ["check"], lock(blank)).out).toContain(
      "declare scaffolding.brand.retired",
    );
    const unpinned = gate({ skip: { ...skip, retired: "brand only in tests" } });
    expect(run(unpinned, "scaffolding", ["check"], lock(unpinned)).out).toContain(
      "scaffolding.skip names no shared step: retired",
    );
  });

  test.each([
    ["colours", "cd site && brand-colours", '[ "$#" = 0 ] && test -f paint.css', "site/paint.css"],
    ["copies", "brand-copies", '[ "$#" = 0 ] && test -f mark.svg', "mark.svg"],
    [
      "retired",
      "brand-retired site/dist 'more output'",
      '[ "$*" = "site/dist more output" ] && [ "$#" = 2 ] && test -f "$2/page.html"',
      "more output/page.html",
    ],
    [
      "elements",
      "cd site && brand-elements",
      '[ "$#" = 0 ] && test -f brand-elements.json',
      "site/brand-elements.json",
    ],
  ])(
    "shared %s passes the pinned bin the same inputs as the local step",
    (name, command, predicate, input) => {
      const local = `check:${name}`;
      for (const useLocal of [true, false]) {
        const skips = {
          ...skip,
          ...Object.fromEntries(
            ["colours", "copies", "retired", "elements"]
              .filter((step) => step !== name)
              .map((step) => [step, "fixture checks one scan"]),
          ),
        };
        const dir = gate(
          {
            skip: skips,
            brand: { directory: "site", retired: ["site/dist", "more output"] },
            check: useLocal ? [local] : [],
          },
          { [local]: command },
          { devDependencies: { "@hackersandwizards/brand": "file:brand" } },
        );
        write(dir, {
          "brand/package.json": JSON.stringify({
            name: "@hackersandwizards/brand",
            bin: { [`brand-${name}`]: "check.sh" },
          }),
          "brand/check.sh": `#!/bin/sh\n${predicate} || exit 2\ngrep -q clean ${JSON.stringify(input.replace(name === "colours" || name === "elements" ? /^site\// : /$^/, ""))}\n`,
          [input]: "bad",
        });
        chmodSync(join(dir, "brand/check.sh"), 0o755);
        const step = useLocal ? local : name;
        const env = { CHECK_LOCK: join(dir, ".lock") };
        const red = run(dir, "scaffolding", ["check"], env);
        expect(red.code).toBe(1);
        expect(red.out).toContain(`FAIL ${step}`);
        write(dir, { [input]: "clean" });
        const green = run(dir, "scaffolding", ["check"], env);
        expect(green.code).toBe(0);
        expect(green.out).toContain(`ok   ${step}`);
      }
    },
  );

  test("pins runs the installed slides bin in full and changed checks, while its owner keeps check:pins", () => {
    const env = { CHECK_LOCK: join(temp(), "lock") };
    const dir = gate(
      { skip },
      {},
      { devDependencies: { "@hackersandwizards/slides": "file:slides" } },
    );
    write(dir, {
      "slides/package.json": JSON.stringify({
        name: "@hackersandwizards/slides",
        bin: { "slides-pins": "pins.sh" },
      }),
      "slides/pins.sh": "#!/bin/sh\necho slides-pins-fixture\ntest -f accepted\n",
    });
    chmodSync(join(dir, "slides/pins.sh"), 0o755);
    const red = run(dir, "scaffolding", ["check"], env);
    expect(red.code).toBe(1);
    expect(red.out).toContain("slides-pins-fixture");
    expect(red.out).toContain("FAIL pins");
    write(dir, { accepted: "" });
    sh(dir, ["add", "slides", "accepted"]);
    sh(dir, ["commit", "-qm", "pin"]);
    write(dir, { "docs/readme.md": "# Fixture" });
    const green = run(dir, "scaffolding", ["check", "--changed"], env);
    expect(green.code, green.out).toBe(0);
    expect(green.out).toContain("selected pins: runs on every changed check");
    expect(green.out).toContain("ok   pins");
    const owner = gate(
      { skip, check: ["check:pins"] },
      { "check:pins": "echo own-pins-fixture" },
      { name: "@hackersandwizards/slides" },
    );
    const local = run(owner, "scaffolding", ["check"], env);
    expect(local.code, local.out).toBe(0);
    expect(local.out).toContain("own-pins-fixture");
    expect(local.out).toContain("ok   check:pins");
    expect(local.out).not.toContain("ok   pins");
  });

  test.each(["test/pages", "test/browser"])(
    "browserTest splits %s and waits for the build",
    (folder) => {
      const { catalog: _, test: _test, ...enabled } = skip;
      const dir = gate(
        { skip: enabled, browserTest: folder, check: ["browser-test"] },
        { build: "touch built", test: "scaffolding test" },
      );
      write(dir, {
        "node_modules/.bin/vitest": `#!/usr/bin/env bun
        const args = process.argv.slice(2);
        console.log("vitest arguments", JSON.stringify(args));
        if (args[1] !== "--exclude" && !(await Bun.file("built").exists())) process.exit(9);
        if (args[1] !== "--exclude" && await Bun.file("broken").exists()) process.exit(1);
      `,
      });
      chmodSync(join(dir, "node_modules/.bin/vitest"), 0o755);
      const env = { CHECK_LOCK: join(temp(), "lock") };
      const direct = run(dir, "scaffolding", ["test", "unit.test.ts"], env);
      expect(direct.code, direct.out).toBe(0);
      expect(direct.out).toContain(
        JSON.stringify(["run", "--exclude", `${folder}/**`, "unit.test.ts"]),
      );
      write(dir, { "src/input.ts": "", "src/broken.ts": "" });
      const changed = run(dir, "scaffolding", ["check", "--changed"], env);
      expect(changed.code, changed.out).toBe(0);
      expect(changed.out).toContain("deferred browser-test");
      expect(changed.out).toContain(JSON.stringify(["run", "--exclude", `${folder}/**`]));
      expect(changed.out).not.toContain(JSON.stringify(["run", folder]));
      write(dir, { broken: "" });
      const full = run(dir, "scaffolding", ["check"], env);
      expect(full.code).toBe(1);
      expect(full.out).toContain("ok   catalog");
      expect(full.out).toContain("ok   test");
      expect(full.out).toContain(JSON.stringify(["run", folder]));
      expect(full.out).toContain("FAIL browser-test");
      expect(full.out).toMatch(/failed in [\d.]+ s: browser-test\n/);
    },
  );

  test("fix and explore resolve as bins without scripts, and fix stops when ESLint fails", () => {
    const dir = gate({ skip });
    const bins = join(dir, "node_modules/.bin");
    write(dir, {
      "node_modules/.bin/eslint": `#!/usr/bin/env bun
        console.log("eslint", JSON.stringify(process.argv.slice(2)));
        if (await Bun.file("broken").exists()) process.exit(7);
      `,
      "node_modules/.bin/prettier": `#!/usr/bin/env bun
        console.log("prettier", JSON.stringify(process.argv.slice(2)));
      `,
    });
    for (const command of ["eslint", "prettier"]) chmodSync(join(bins, command), 0o755);
    for (const command of ["scaffolding", "scaffolding-explore"])
      symlinkSync(bin(command), join(bins, command));
    const bun = (...args: string[]) =>
      spawnSync(process.execPath, ["run", ...args], {
        cwd: dir,
        encoding: "utf8",
      });
    const explore = bun("scaffolding-explore", "--help");
    expect(explore.status, explore.stderr).toBe(0);
    expect(explore.stdout).toContain("usage: scaffolding-explore");
    const green = bun("scaffolding", "fix");
    expect(green.status, green.stderr).toBe(0);
    expect(green.stdout.trim().split("\n")).toEqual([
      'eslint ["--cache","--concurrency=auto",".","--fix"]',
      'prettier ["--write","."]',
    ]);
    write(dir, { broken: "" });
    const red = bun("scaffolding", "fix");
    expect(red.status, red.stderr).toBe(7);
    expect(red.stdout).not.toContain("prettier");
  });

  test("a skipped step must name an own entry in the shared step table", () => {
    const dir = gate({ skip: { ...skip, constructor: "not a step" } });
    const result = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(result.code).toBe(1);
    expect(result.out).toContain("scaffolding.skip names no shared step: constructor");
  });

  test("changed checks scope colours to the brand directory, include binary copies and defer built scans", () => {
    const dir = gate(
      { skip, brand: { directory: "site", retired: ["site/dist"] } },
      {},
      { devDependencies: { "@hackersandwizards/brand": "file:brand" } },
    );
    write(dir, {
      "brand/package.json": JSON.stringify({
        name: "@hackersandwizards/brand",
        bin: { "brand-colours": "colours.sh", "brand-copies": "copies.sh" },
      }),
      "brand/colours.sh": "#!/bin/sh\nexit 0\n",
      "brand/copies.sh": "#!/bin/sh\nexit 0\n",
    });
    for (const scan of ["colours", "copies"]) chmodSync(join(dir, `brand/${scan}.sh`), 0o755);
    sh(dir, ["add", "brand"]);
    sh(dir, ["commit", "-qm", "pin"]);
    const env = { CHECK_LOCK: join(temp(), "lock") };
    write(dir, { "assets/partner.svg": "<svg/>", "assets/sample.png": "binary fixture" });
    const outside = run(dir, "scaffolding", ["check", "--changed"], env);
    expect(outside.code, outside.out).toBe(0);
    expect(outside.out).toContain("selected copies");
    expect(outside.out).toContain("skipped colours: no changed path maps to it");
    expect(outside.out).toContain("deferred retired");
    expect(outside.out).toContain("deferred elements");
    write(dir, { "site/card.css": "p {}" });
    const inside = run(dir, "scaffolding", ["check", "--changed"], env);
    expect(inside.out).toContain('selected colours: matches "site/card.css"');
    expect(inside.code).toBe(0);
  });

  test("links crawls the preview build with the local skip prefixes and fails on the same broken page", () => {
    for (const step of ["check:links", "links"]) {
      const server = 'exec bun server.ts "$PORT"';
      const dir = gate(
        {
          skip,
          server: { command: server, timeout: 5, stderr: true },
          linkSkips: ["/catalog"],
          fullOnly: {
            "check:preview": "builds the preview",
            ...(step === "check:links" ? { [step]: "crawls the built site" } : {}),
          },
          check: ["check:preview", step],
        },
        {
          "check:preview": "mkdir -p .preview && cp page.html .preview/index.html",
          "check:links": `with-server --timeout 5 --stderr '${server}' -- check-links {url} --skip /catalog`,
        },
      );
      write(dir, {
        "page.html": '<a href="/missing">missing</a><a href="/catalog/missing">skipped</a>',
        "server.ts": `Bun.serve({ port: Number(process.argv[2]), hostname: "127.0.0.1", fetch(req) {
          const path = new URL(req.url).pathname;
          if (path === "/") return new Response(Bun.file(".preview/index.html"));
          return new Response(null, { status: path === "/found" ? 200 : 404 });
        } }); console.error("fixture server started");`,
      });
      mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
      for (const command of ["with-server", "check-links"])
        symlinkSync(bin(command), join(dir, "node_modules/.bin", command));
      const env = { CHECK_LOCK: join(temp(), "lock") };
      const changed = run(dir, "scaffolding", ["check", "--changed"], env);
      expect(changed.code, changed.out).toBe(0);
      expect(changed.out).toContain(`deferred ${step}`);
      expect(changed.out).not.toContain("fixture server started");
      const red = run(dir, "scaffolding", ["check"], env);
      expect(red.code).toBe(1);
      expect(red.out).toContain("ok   check:preview");
      expect(red.out).toContain("fixture server started");
      expect(red.out).toContain("/missing (404) <- /");
      expect(red.out).not.toContain("/catalog/missing");
      expect(red.out).toContain(`FAIL ${step}`);
      if (step === "check:links") {
        expect(red.out).toContain("links uses local check:links");
        expect(red.out).not.toContain("FAIL links");
      }
      write(dir, {
        "page.html": '<a href="/found">found</a><a href="/catalog/missing">skipped</a>',
      });
      const green = run(dir, "scaffolding", ["check"], env);
      expect(green.code, green.out).toBe(0);
      expect(green.out).toContain(`ok   ${step}`);
    }
  });

  test("server-backed elements sees the built site through the declared base URL", () => {
    const { catalog: _, ...previewSkips } = skip;
    const dir = gate(
      {
        skip: {
          ...previewSkips,
          colours: "fixture",
          copies: "fixture",
          retired: "fixture",
          links: "fixture",
        },
        brand: { elements: "server" },
        server: { command: 'exec bun server.ts "$PORT"', timeout: 5, stderr: true },
      },
      { build: "printf 'element fixture' > built.html" },
      { devDependencies: { "@hackersandwizards/brand": "file:brand" } },
    );
    write(dir, {
      "brand/package.json": JSON.stringify({
        name: "@hackersandwizards/brand",
        bin: { "brand-elements": "elements.ts" },
      }),
      "brand/elements.ts": `#!/usr/bin/env bun
        const [flag, address, ...extra] = process.argv.slice(2);
        const response = await fetch(address);
        if (flag !== "--base" || extra.length || await response.text() !== "element fixture") process.exit(1);
        console.log("elements fetched the built page");
      `,
      "server.ts": `Bun.serve({ port: Number(process.argv[2]), hostname: "127.0.0.1",
        fetch: () => new Response(Bun.file("built.html"))
      }); console.error("elements server started");`,
    });
    chmodSync(join(dir, "brand/elements.ts"), 0o755);
    const result = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(temp(), "lock") });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("ok   catalog");
    expect(result.out).toContain("elements server started");
    expect(result.out).toContain("elements fetched the built page");
    expect(result.out).toContain("ok   elements");
    expect(result.out).not.toContain("ok   links");
  });

  test("a test command named like an Object member runs directly", () => {
    const { test: _, ...noTest } = skip;
    const dir = gate({ skip: noTest, test: "constructor" });
    write(dir, {
      "tools/constructor": "#!/bin/sh\necho ran-constructor\n",
      constructor: "#!/bin/sh\necho ran-local-file\nexit 1\n",
    });
    for (const file of ["tools/constructor", "constructor"]) chmodSync(join(dir, file), 0o755);
    const result = run(dir, "scaffolding", ["check"], {
      CHECK_LOCK: join(dir, ".lock"),
      PATH: `${join(dir, "tools")}${delimiter}${process.env.PATH}`,
    });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("ran-constructor");
  });

  test("a gate without tests goes red unless the skip gives a reason", () => {
    const { test: _, ...noTest } = skip;
    const dir = gate({ skip: noTest });
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(1);
    expect(r.out).toContain("scaffolding.test is missing");
    const named = gate({ skip: noTest, test: "echo ran-tests" });
    const ok = run(named, "scaffolding", ["check"], { CHECK_LOCK: join(named, ".lock") });
    expect(ok.out).toContain("ran-tests");
    expect(ok.code).toBe(0);
  });

  test("the catalog build is a shared step: bun run build", () => {
    const { catalog: _, ...noCatalog } = skip;
    const built = gate({ skip: noCatalog }, { build: "echo ran-build" });
    const ok = run(built, "scaffolding", ["check"], { CHECK_LOCK: join(built, ".lock") });
    expect(ok.out).toContain("ok   catalog");
    expect(ok.out).toContain("ran-build");
    expect(ok.code).toBe(0);
    const broken = gate({ skip: noCatalog }, { build: "exit 3" });
    const r = run(broken, "scaffolding", ["check"], { CHECK_LOCK: join(broken, ".lock") });
    expect(r.out).toContain("FAIL catalog");
    expect(r.code).toBe(1);
  });

  test("the catalog build starts once a typecheck running Astro has finished", () => {
    const { catalog: _, typecheck: __, ...rest } = skip;
    const dir = gate(
      { skip: rest, typecheck: "run check:types --pretty" },
      // A script name, among other words, whose body runs Astro counts as Astro.
      { "check:types": "sleep 1 && touch tc-done && echo astro", build: "test -f tc-done" },
    );
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.out).toContain("ok   catalog");
    expect(r.code).toBe(0);
    // A typecheck without Astro shares no cache with the build, which starts beside it: the
    // typecheck passes only once the build has run, within 3 s.
    const beside = gate(
      { skip: rest, typecheck: "tc" },
      {
        tc: "for i in $(seq 60); do test -f built && exit 0; sleep 0.05; done; exit 1",
        build: "touch built",
      },
    );
    const b = run(beside, "scaffolding", ["check"], { CHECK_LOCK: join(beside, ".lock") });
    expect(b.out).toContain("ok   typecheck");
    expect(b.out).toContain("ok   catalog");
    const failed = gate(
      { skip: rest, typecheck: "astro" },
      { astro: "exit 1", build: "echo built" },
    );
    const f = run(failed, "scaffolding", ["check"], { CHECK_LOCK: join(failed, ".lock") });
    expect(f.out).toContain("FAIL typecheck");
    expect(f.out).toContain("ok   catalog");
  });

  test("a private repository's gate leaves the confidential scan to check-confidential", () => {
    const { confidential: _, ...rest } = skip;
    const dir = gate({ skip: rest, private: true }, {});
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.out).toContain("ok   confidential");
  });

  test("the styles step prints one line per finding and fails", () => {
    const { styles: _, ...noStyles } = skip;
    const dir = repo({
      "package.json": JSON.stringify({
        name: "fx",
        type: "module",
        scaffolding: { skip: noStyles },
      }),
      "node_modules/@hackersandwizards/brand/package.json": JSON.stringify({
        exports: { "./tokens.root.css": "./tokens.root.css" },
      }),
      "node_modules/@hackersandwizards/brand/tokens.root.css": ":root { --color-ink: #000; }\n",
      "stylelint.config.js": `import styles from "${join(import.meta.dirname, "..", "config", "stylelint.js")}";\nexport default { ...styles(), ignoreFiles: ["nested/**"] };\n`,
      "src/bad.css": "a { color: var(--color-nope); }\n",
      "nested/.stylelintrc.json": "{}",
      "nested/Odd.astro": "---\nconst x = 1;\n---\n<p>{x}</p>\n",
      "src/Bad.astro":
        '---\nconst x = "";\n---\n<style set:html={x} />\n<p>a</p>\n<style>\n  p { color: var(--color-astro); }\n</style>\n',
    });
    mkdirSync(join(dir, "node_modules/.bin"));
    symlinkSync(
      join(import.meta.dirname, "..", "node_modules/stylelint/bin/stylelint.mjs"),
      join(dir, "node_modules/.bin/stylelint"),
    );
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.out).toContain(
      'src/bad.css: line 1, col 16, error - Unexpected custom property "--color-nope"',
    );
    expect(r.out).toContain(
      'src/Bad.astro: line 7, col 18, error - Unexpected custom property "--color-astro"',
    );
    expect(r.out).not.toContain("nested/Odd.astro");
    expect(r.out).toContain("FAIL styles");
    expect(r.code).toBe(1);
  });

  test("the admin step runs the pinned admin-check; without admin pinned it needs skip.admin", () => {
    const { admin: _, ...noAdmin } = skip;
    const bare = gate({ skip: noAdmin });
    const unpinned = run(bare, "scaffolding", ["check"], { CHECK_LOCK: join(bare, ".lock") });
    expect(unpinned.code).toBe(1);
    expect(unpinned.out).toContain(
      "@hackersandwizards/admin is not pinned: pin it, or skip.admin with a reason",
    );
    const pinned = (verdict: string) => {
      const dir = repo({
        "package.json": JSON.stringify({
          name: "fx",
          type: "module",
          devDependencies: { "@hackersandwizards/admin": "file:./admin" },
          scaffolding: { skip: noAdmin },
        }),
        "admin/package.json": JSON.stringify({
          name: "@hackersandwizards/admin",
          bin: { "admin-check": "check.sh" },
        }),
        "admin/check.sh": `#!/bin/sh\necho admin-check-ran\n${verdict}\n`,
      });
      spawnSync("chmod", ["+x", join(dir, "admin/check.sh")]);
      return run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    };
    const red = pinned("exit 1");
    expect(red.out).toContain("admin-check-ran");
    expect(red.out).toContain("FAIL admin");
    expect(red.code).toBe(1);
    const green = pinned("exit 0");
    expect(green.out).toContain("ok   admin");
    expect(green.code).toBe(0);
  });

  test("an unknown key, an unknown skip and a skip without reason go red", () => {
    for (const config of [
      { skip, chek: [] },
      { skip: { ...skip, lnt: "t" } },
      { skip: { ...skip, lint: " " } },
    ]) {
      const dir = gate(config);
      expect(run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") }).code).toBe(1);
    }
  });

  test("a skip whose value is no text gives no reason", () => {
    for (const lint of [false, 0, {}, true, ""]) {
      const dir = gate({ skip: { ...skip, lint } });
      const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
      expect(r.out).toContain("scaffolding.skip.lint has no reason");
      expect(r.code).toBe(1);
    }
  });
});

describe("skeleton install hooks", () => {
  const hooks = join(import.meta.dirname, "..", "template/.githooks");
  // bun's install and the MCP server logged with whether the lock was held; every other call is
  // the real bun's, so check-lock runs as it does in a consumer.
  const fakeBun = () => {
    const fake = temp();
    writeFileSync(
      join(fake, "bun"),
      `#!/bin/sh
case "$*" in
  "install --frozen-lockfile")
    [ -e node_modules/.check.lock ] && held=" locked" || held=
    echo "$CHECK_LOCK_RUN_S" > "${fake}/bound"
    echo "start$held" >> "$BUN_LOG"
    sleep "\${BUN_SLEEP:-0}"
    echo end >> "$BUN_LOG"
    exit "\${BUN_EXIT:-0}";;
  "run --silent chrome-mcp") echo mcp >> "$BUN_LOG"; exit 0;;
esac
exec "${process.execPath}" "$@"
`,
      { mode: 0o755 },
    );
    return { fake, log: join(fake, "bun.log"), bound: join(fake, "bound") };
  };
  // A consumer with the hooks as the skeleton ships them, check-lock's copy among them.
  const consumer = (files: Record<string, string> = {}) => {
    const dir = repo({ "bun.lock": "a\n", "package.json": "{}\n", ...files });
    cpSync(hooks, join(dir, ".githooks"), { recursive: true });
    return dir;
  };
  const env = (log: { fake: string; log: string }, more: Record<string, string> = {}) => ({
    ...process.env,
    PATH: `${log.fake}:${process.env.PATH}`,
    BUN_LOG: log.log,
    ...more,
  });
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
  // The MCP server's start in dir, from the skeleton's .mcp.json, its project folder as the last argument.
  const mcp = templateMcp.mcpServers["chrome-devtools"];
  const mcpStart = (dir: string, options: Parameters<typeof spawnSync>[2]) =>
    spawnSync(mcp.command, [...mcp.args.slice(0, -1), dir], options);
  const head = (dir: string) => sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
  /** The post-checkout arguments of a checkout that changed bun.lock. */
  const lockChange = (dir: string) => {
    const old = head(dir);
    write(dir, { "bun.lock": "b\n" });
    sh(dir, ["commit", "-q", "-am", "b"]);
    return [old, head(dir), "1"];
  };
  const twice = "start locked\nend\nstart locked\nend\n";
  // Two at once, the first holding its install for 2 s: the second's result once both have ended.
  const both = async (
    command: string,
    args: string[],
    cwd: string,
    bun: { fake: string; log: string },
  ) => {
    const first = spawn(command, args, { cwd, env: env(bun, { BUN_SLEEP: "2" }), stdio: "ignore" });
    const done = new Promise((resolve) => first.on("close", resolve));
    const second = spawnSync(command, args, { cwd, env: env(bun), encoding: "utf8" });
    await done;
    return second;
  };

  test("a changed lock installs under check-lock's lock, after a checkout and a merge", () => {
    const dir = consumer();
    const args = lockChange(dir);
    sh(dir, ["update-ref", "ORIG_HEAD", args[0]]);
    const bun = fakeBun();
    const hook = (name: string, args: string[]) =>
      spawnSync(join(dir, ".githooks", name), args, { cwd: dir, env: env(bun), encoding: "utf8" });
    const fresh = hook("post-checkout", args);
    expect(read(bun.log)).toBe("start locked\nend\n");
    expect(`${fresh.stdout}${fresh.stderr}`).toBe("");
    expect(existsSync(join(dir, "node_modules/.check.lock"))).toBe(false);
    rmSync(bun.log);
    const later = hook("post-merge", ["0"]);
    expect(read(bun.log)).toBe("start locked\nend\n");
    expect(`${later.stdout}${later.stderr}`).toBe("");
    // An unchanged lock installs nothing.
    rmSync(bun.log);
    hook("post-checkout", [args[1], args[1], "1"]);
    expect(read(bun.log)).toBe("");
  });

  test("a gate's lock or a failed install is named on stderr, never stdout, and fails no checkout", () => {
    const dir = consumer();
    mkdirSync(join(dir, "node_modules"));
    const bun = fakeBun();
    const install = (more: Record<string, string> = {}) =>
      spawnSync(join(dir, ".githooks/install"), [], {
        cwd: dir,
        env: env(bun, more),
        encoding: "utf8",
      });
    writeFileSync(
      join(dir, "node_modules/.check.lock"),
      JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        command: ["bun", "x.ts", "check"],
      }),
    );
    const held = install();
    expect(read(bun.log)).toBe("");
    expect(held.stdout).toBe("");
    expect(held.stderr).toContain(`pid ${process.pid} still holds`);
    expect(held.stderr).toContain("[install] bun install --frozen-lockfile did not run or failed");
    expect(held.status).toBe(1);
    // A git command a gate runs in its own checkout inherits SCAFFOLDING_LOCKED, which let the
    // hook's install run at once, beside the gate's other steps.
    const lock = join(realpathSync(dir), "node_modules/.check.lock");
    expect(install({ SCAFFOLDING_LOCKED: lock }).status).toBe(1);
    expect(read(bun.log)).toBe("");
    rmSync(join(dir, "node_modules/.check.lock"));
    const failed = install({ BUN_EXIT: "1" });
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("[install]");
    expect(failed.status).toBe(1);
    const checkout = spawnSync(join(dir, ".githooks/post-checkout"), lockChange(dir), {
      cwd: dir,
      env: env(bun, { BUN_EXIT: "1" }),
      encoding: "utf8",
    });
    expect(checkout.stderr).toContain("[install]");
    expect(checkout.status).toBe(0);
  });

  // Offline, a new worktree's install waited on the network with no end, and `worktree add` with it.
  test(
    "a new worktree's install past CHECK_LOCK_RUN_S is stopped, its lock released, and the checkout goes on",
    () => {
      const dir = consumer();
      const bun = fakeBun();
      const checkout = spawnSync(
        join(dir, ".githooks/post-checkout"),
        ["0".repeat(40), head(dir), "1"],
        {
          cwd: dir,
          env: env(bun, { BUN_SLEEP: "30", CHECK_LOCK_RUN_S: "1" }),
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      expect(checkout.status).toBe(0);
      expect(checkout.stderr).toContain(`run it in ${realpathSync(dir)} before your gate`);
      expect(existsSync(join(dir, "node_modules/.check.lock"))).toBe(false);
      expect(read(bun.log)).toBe("start locked\n");
    },
    limit(20_000),
  );

  // Behind a network that never answers, an install waited with no end, and the checkout, the
  // merge, the session's start or the MCP server's start with it.
  test.each(["post-checkout", "post-merge", "session-start", "MCP server's start"])(
    "%s bounds its install at 60 s unless CHECK_LOCK_RUN_S is set",
    (caller) => {
      const dir = consumer();
      const bun = fakeBun();
      const args = lockChange(dir);
      sh(dir, ["update-ref", "ORIG_HEAD", args[0]]);
      const start = (bound?: string) => {
        const options = { cwd: dir, env: env(bun) as Record<string, string | undefined> };
        if (bound === undefined) delete options.env.CHECK_LOCK_RUN_S;
        else options.env.CHECK_LOCK_RUN_S = bound;
        if (caller === "MCP server's start") return mcpStart(dir, options);
        return spawnSync(
          join(dir, ".githooks", caller),
          caller === "post-merge" ? ["0"] : args,
          options,
        );
      };
      start();
      expect(read(bun.bound)).toBe("60\n");
      start("5");
      expect(read(bun.bound)).toBe("5\n");
      // An empty one too, in the hooks; Claude Code expands .mcp.json's default itself and keeps it.
      if (caller === "MCP server's start") return;
      start("");
      expect(read(bun.bound)).toBe("60\n");
    },
  );

  // The MCP server's start and the SessionStart hook install at the same moment.
  test("two first installs at once wait for each other, the second without a word", async () => {
    const dir = consumer();
    const bun = fakeBun();
    const second = await both(join(dir, ".githooks/install"), [], dir, bun);
    expect(`${second.stdout}${second.stderr}`).toBe("");
    expect(second.status).toBe(0);
    expect(read(bun.log)).toBe(twice);
  });

  // check-lock's lock, staging and claim files; its queue folder stays.
  const leftovers = (dir: string) =>
    readdirSync(join(dir, "node_modules")).filter((name) => name !== ".check.lock.queue");
  // A first install whose bun outlived its shell, as check-lock writes it.
  const orphan = (dir: string, group?: number) => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules/.check.lock"),
      JSON.stringify({
        pid: spawnSync("true").pid,
        startedAt: 1,
        command: ["bun", "install", "--frozen-lockfile"],
        group,
      }),
    );
  };

  test("a dead first install's lock is taken over once, and two waiters still install one at a time", async () => {
    const dir = consumer();
    orphan(dir);
    const bun = fakeBun();
    await both(join(dir, ".githooks/install"), [], dir, bun);
    expect(read(bun.log)).toBe(twice);
    expect(leftovers(dir)).toEqual([]);
  });

  test.each(["SIGKILL", "SIGTERM"] as const)(
    "a first install whose shell got %s holds the lock until its bun has ended",
    async (signal) => {
      const dir = consumer();
      const bun = fakeBun();
      const first = spawn(join(dir, ".githooks/install"), [], {
        cwd: dir,
        env: env(bun, { BUN_SLEEP: "2" }),
        stdio: "ignore",
      });
      for (
        let i = 0;
        i < 200 && !read(join(dir, "node_modules/.check.lock")).includes('"group"');
        i++
      )
        await Bun.sleep(50);
      expect(read(join(dir, "node_modules/.check.lock"))).toContain('"group"');
      // Reaped before the next call blocks the event loop: an unreaped shell reads as live.
      const gone = new Promise((resolve) => first.on("exit", resolve));
      first.kill(signal);
      await gone;
      spawnSync(join(dir, ".githooks/install"), [], { cwd: dir, env: env(bun) });
      expect(read(bun.log)).toBe(twice);
    },
    20_000,
  );

  test(
    "a lock whose pid is dead and whose group runs is waited for; an empty one is stale",
    async () => {
      const dir = consumer();
      const group = spawn("sleep", ["30"]);
      orphan(dir, group.pid);
      const bun = fakeBun();
      const install = spawn(join(dir, ".githooks/install"), [], { cwd: dir, env: env(bun) });
      const done = new Promise((resolve) => install.on("close", resolve));
      await Bun.sleep(1_500);
      expect(read(bun.log)).toBe("");
      group.kill();
      await done;
      expect(read(bun.log)).toBe("start locked\nend\n");
      rmSync(bun.log);
      writeFileSync(join(dir, "node_modules/.check.lock"), "");
      spawnSync(join(dir, ".githooks/install"), [], { cwd: dir, env: env(bun), timeout: 10_000 });
      expect(read(bun.log)).toBe("start locked\nend\n");
      expect(leftovers(dir)).toEqual([]);
    },
    limit(20_000),
  );

  test("a new worktree installs, so its first commit finds node_modules", () => {
    const dir = consumer();
    sh(dir, ["add", "-A"]);
    sh(dir, ["commit", "-qm", "hooks"]);
    sh(dir, ["config", "core.hooksPath", ".githooks"]);
    const bun = fakeBun();
    const tree = join(temp(), "tree");
    const added = spawnSync("git", ["worktree", "add", "-q", "--detach", tree], {
      cwd: dir,
      env: env(bun),
      encoding: "utf8",
    });
    // Offline the install can hang, and the person sees what runs.
    expect(added.stderr).toContain("[post-checkout] installing node_modules in the new worktree");
    expect(read(bun.log)).toBe("start locked\nend\n");
    expect(existsSync(join(tree, "node_modules"))).toBe(true);
  });

  // Git LFS writes its hooks while it checks out a file ahead of .githooks/; a smudge filter that
  // writes post-commit stands in for it.
  test.each([
    ["an untracked", {}, false],
    ["an ignored", { ".gitignore": "node_modules\n.githooks/post-commit\n" }, false],
    ["a tracked", { ".githooks/post-commit": "#!/bin/sh\n" }, true],
  ] as const)("a new worktree keeps %s post-commit only where git tracks it", (_, files, kept) => {
    const dir = consumer({
      ".gitattributes": ".claude/* filter=plant\n",
      ".claude/a": "a\n",
      ...files,
    });
    sh(dir, ["add", "-A"]);
    sh(dir, ["commit", "-qm", "hooks"]);
    sh(dir, ["config", "core.hooksPath", ".githooks"]);
    sh(dir, [
      "config",
      "filter.plant.smudge",
      "mkdir -p .githooks && : > .githooks/post-commit && cat",
    ]);
    const tree = join(temp(), "tree");
    spawnSync("git", ["worktree", "add", "-q", "--detach", tree], {
      cwd: dir,
      env: env(fakeBun()),
    });
    expect(existsSync(join(tree, ".githooks/post-commit"))).toBe(kept);
    expect(sh(dir, ["worktree", "remove", tree]).status).toBe(0);
  });

  test("a switch back from an unborn branch keeps an untracked post-commit and installs nothing", () => {
    const dir = consumer();
    sh(dir, ["add", "-A"]);
    sh(dir, ["commit", "-qm", "hooks"]);
    sh(dir, ["config", "core.hooksPath", ".githooks"]);
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, ".githooks/post-commit"), "#!/bin/sh\n");
    const bun = fakeBun();
    const branch = sh(dir, ["branch", "--show-current"]).stdout.toString().trim();
    for (const args of [["--orphan", "unborn"], [branch]])
      expect(spawnSync("git", ["switch", "-q", ...args], { cwd: dir, env: env(bun) }).status).toBe(
        0,
      );
    expect(existsSync(join(dir, ".githooks/post-commit"))).toBe(true);
    expect(existsSync(bun.log)).toBe(false);
  });

  test("the MCP server starts after the install, with nothing but the server on stdout", () => {
    const dir = consumer();
    const bun = fakeBun();
    const start = mcpStart(dir, {
      cwd: tmpdir(),
      env: env(bun, { BUN_EXIT: "1" }),
      encoding: "utf8",
    });
    expect(read(bun.log)).toBe("start locked\nend\nmcp\n");
    expect(start.stdout).toBe("");
    expect(start.stderr).toContain("[install]");
  });
});

describe("skeleton SessionStart hook", () => {
  const hook = join(import.meta.dirname, "..", "template/.githooks/session-start");
  // A clone of an origin one commit ahead, its install a no-op that logs.
  const clone = () => {
    const origin = repo({ "a.txt": "1\n" });
    const dir = temp();
    spawnSync("git", ["clone", "-q", origin, dir]);
    cpSync(join(import.meta.dirname, "..", "template/.githooks"), join(dir, ".githooks"), {
      recursive: true,
    });
    write(origin, { "a.txt": "2\n" });
    sh(origin, ["commit", "-q", "-am", "two"]);
    const fake = temp();
    // The install a no-op; the fetch's timer the real bun's.
    writeFileSync(
      join(fake, "bun"),
      `#!/bin/sh\n[ "$1" = install ] && exit 0\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
    return { dir, origin, path: `${fake}:${process.env.PATH}` };
  };
  // dash, Debian's and Ubuntu's /bin/sh, makes no process group for `set -m` without a terminal.
  const shells = ["/bin/sh", "/bin/dash"].filter((shell) => existsSync(shell));
  const start = (dir: string, env: Record<string, string>, shell = "/bin/sh") =>
    spawnSync(shell, [hook], { cwd: dir, env: { ...process.env, ...env }, encoding: "utf8" });
  const head = (dir: string) => sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();

  test("fetches and says how far behind main is, and moves no branch under uncommitted work", () => {
    const { dir, path } = clone();
    const before = head(dir);
    write(dir, { "b.txt": "another session's\n" });
    const r = start(dir, { PATH: path });
    expect(r.stdout).toBe(
      "origin/main is 1 commits ahead of HEAD: merge it per git.md before work\n",
    );
    expect(head(dir)).toBe(before);
    sh(dir, ["merge", "-q", "--ff-only", "origin/main"]);
    expect(start(dir, { PATH: path }).stdout).toBe("");
    // A bound that is no number of seconds, or 0, is the default, with no warning from the timer.
    for (const bound of ["20s", "0"])
      expect(start(dir, { PATH: path, SCAFFOLDING_FETCH_WAIT_S: bound }).stdout).toBe("");
  });

  test("a clone of one other branch still learns how far main is ahead", () => {
    const { dir, origin, path } = clone();
    sh(origin, ["branch", "-q", "work", "HEAD~1"]);
    const single = temp();
    spawnSync("git", ["clone", "-q", "--single-branch", "--branch", "work", origin, single]);
    cpSync(join(dir, ".githooks"), join(single, ".githooks"), { recursive: true });
    expect(start(single, { PATH: path }).stdout).toBe(
      "origin/main is 1 commits ahead of HEAD: merge it per git.md before work\n",
    );
  });

  test("a cloud session switches to main and fast-forwards", () => {
    const { dir, origin, path } = clone();
    sh(dir, ["switch", "-q", "-c", "work"]);
    const r = start(dir, { PATH: path, CLAUDE_CODE_REMOTE: "true" });
    expect(r.stdout).toBe("");
    expect(sh(dir, ["branch", "--show-current"]).stdout.toString()).toBe("main\n");
    expect(head(dir)).toBe(head(origin));
  });

  test("a cloud session in a clone of one other branch switches to main", () => {
    const { dir, origin, path } = clone();
    sh(origin, ["branch", "-q", "work", "HEAD~1"]);
    const single = temp();
    spawnSync("git", ["clone", "-q", "--single-branch", "--branch", "work", origin, single]);
    cpSync(join(dir, ".githooks"), join(single, ".githooks"), { recursive: true });
    const r = start(single, { PATH: path, CLAUDE_CODE_REMOTE: "true" });
    expect(r.stdout).toBe("");
    expect(sh(single, ["branch", "--show-current"]).stdout.toString()).toBe("main\n");
    expect(head(single)).toBe(head(origin));
    expect(sh(single, ["rev-parse", "--abbrev-ref", "main@{upstream}"]).stdout.toString()).toBe(
      "origin/main\n",
    );
    // Each start without a main, as after a switch that failed, added main's refspec once more.
    sh(single, ["switch", "-q", "work"]);
    sh(single, ["branch", "-q", "-D", "main"]);
    expect(start(single, { PATH: path, CLAUDE_CODE_REMOTE: "true" }).stdout).toBe("");
    expect(sh(single, ["config", "--get-all", "remote.origin.fetch"]).stdout.toString()).toBe(
      "+refs/heads/work:refs/remotes/origin/work\n+refs/heads/main:refs/remotes/origin/main\n",
    );
  });

  // setTimeout ran a delay past 2^31 - 1 ms at once, and the fetch was stopped as it began.
  test("a bound past what setTimeout takes still waits for the fetch", () => {
    const { dir, path } = clone();
    const ssh = join(temp(), "ssh");
    const pid = `${ssh}.pid`;
    writeFileSync(ssh, `#!/bin/sh\necho $$ > ${pid}\nexec sleep 600\n`, { mode: 0o755 });
    sh(dir, ["remote", "set-url", "origin", "git@example.invalid:o/r.git"]);
    const r = spawnSync("/bin/sh", [hook], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: path,
        GIT_SSH_COMMAND: ssh,
        SCAFFOLDING_FETCH_WAIT_S: "2147484",
      },
      encoding: "utf8",
      timeout: 3_000,
    });
    // The fetch's ssh ends, and with it the fetch and its timer.
    for (const end = Date.now() + 20_000; !existsSync(pid) && Date.now() < end;)
      spawnSync("sleep", ["0.1"]);
    process.kill(Number(readFileSync(pid, "utf8")));
    expect(r.stdout).not.toContain("not fetched");
    expect(r.signal).toBe("SIGTERM");
  });

  test("a fetch that fails says so", () => {
    const { dir, path } = clone();
    sh(dir, ["remote", "set-url", "origin", join(dir, "gone")]);
    expect(start(dir, { PATH: path }).stdout).toBe(
      "git fetch origin main failed: fetch and merge per git.md before work\n",
    );
  });

  test.each(shells)(
    "a fetch that waits for a person ends at the bound, its ssh with it (%s)",
    (shell) => {
      const { dir, path } = clone();
      const ssh = join(temp(), "ssh");
      const pid = `${ssh}.pid`;
      writeFileSync(ssh, `#!/bin/sh\necho $$ > ${pid}\nexec sleep 600\n`, { mode: 0o755 });
      sh(dir, ["remote", "set-url", "origin", "git@example.invalid:o/r.git"]);
      const started = performance.now();
      const r = start(
        dir,
        { PATH: path, GIT_SSH_COMMAND: ssh, SCAFFOLDING_FETCH_WAIT_S: "1" },
        shell,
      );
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(r.stdout).toBe(
        "origin main not fetched within 1 s: fetch and merge per git.md before work\n",
      );
      const sleeper = Number(readFileSync(pid, "utf8"));
      expect(() => process.kill(sleeper, 0)).toThrow();
    },
  );
});

describe("shared eslint config", () => {
  // The untyped rules alone, as check-staged runs them: these fixtures sit in no tsconfig.
  const untyped = { ...process.env, SCAFFOLDING_LINT_UNTYPED: "1" };

  test("oxlint owns physical TypeScript's typed rules and rejects files outside the project", () => {
    const dir = repo({
      ".oxlintrc.json": JSON.stringify(oxlintTemplate),
      "eslint.config.js": `export { default } from "${join(import.meta.dirname, "..", "config", "eslint.js")}";\n`,
      "tsconfig.json": '{ "compilerOptions": { "strict": true }, "include": ["src"] }\n',
      "src/a.ts": "const later = async (): Promise<number> => 1;\nlater();\n",
      "src/b.ts": 'const parsed = JSON.parse("{}");\nexport const n: number = parsed.n;\n',
      "src/c.ts": "const later = async () => 1;\nexport const n = await later();\n",
      "src/unused.ts": "const unusedThing = 1;\nexport {};\n",
      ".claude/x.ts": "debugger;\n",
      ".agents/x.ts": "debugger;\n",
      ".githooks/x.ts": "debugger;\n",
      "packages/web/dist/b.js": "debugger;\n",
      ".gitmodules": '[submodule "vendor sub"]\n\tpath = vendor/sub\n\turl = ../sub.git\n',
      "vendor/sub/a.ts": "debugger;\n",
    });
    install(dir);
    const check = () =>
      spawnSync(
        process.execPath,
        ["--no-env-file", join(import.meta.dirname, "../lib/oxlint.ts"), "-f", "json"],
        { cwd: dir, encoding: "utf8" },
      );
    const red = check();
    expect(red.status).toBe(1);
    const diagnostics = jsonObject(red.stdout).diagnostics as { filename: string; code: string }[];
    const findings = diagnostics.map(({ filename, code }) => [filename, code]);
    expect(findings).toEqual(
      expect.arrayContaining([
        ["src/a.ts", "typescript(no-floating-promises)"],
        ["src/b.ts", "typescript(no-unsafe-assignment)"],
        ["src/b.ts", "typescript(no-unsafe-member-access)"],
        ["src/unused.ts", "eslint(no-unused-vars)"],
      ]),
    );
    expect(findings.every(([file]) => /^src\/(a|b|unused)\.ts$/.test(file))).toBe(true);
    const eslint = join(import.meta.dirname, "..", "node_modules", ".bin", "eslint");
    expect(spawnSync(eslint, ["."], { cwd: dir }).status).toBe(0);
    write(dir, { "outside.ts": "export const a = 1;\n" });
    const outside = check();
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain("outside.ts: is outside tsconfig.json");
  });

  test("eslint keeps an overwritten write and oxlint catches redeclaration and const violations", () => {
    const dir = repo({
      ".oxlintrc.json": JSON.stringify(oxlintTemplate),
      "eslint.config.js": `export { default } from "${join(import.meta.dirname, "../config/eslint.js")}";\n`,
      "tsconfig.json": '{"include":["loop.ts"]}\n',
      "loop.ts": "for (let day = new Date(0); day.valueOf() < 1; ) day.setTime(1);\n",
      "control.js": "var same = 0;\nvar same = 1;\nconsole.log(same);\n",
    });
    install(dir);
    const check = () =>
      spawnSync(
        process.execPath,
        ["--no-env-file", join(import.meta.dirname, "../lib/oxlint.ts")],
        {
          cwd: dir,
          encoding: "utf8",
        },
      );
    const red = check();
    expect(red.stdout).toContain("eslint(no-redeclare)");
    expect(red.stdout).toContain("eslint(prefer-const)");
    const eslint = join(import.meta.dirname, "../node_modules/.bin/eslint");
    const fallback = spawnSync(eslint, ["control.js"], { cwd: dir, encoding: "utf8" });
    expect(fallback.status).toBe(1);
    expect(fallback.stdout).toContain("no-useless-assignment");
    expect(fallback.stdout).not.toContain("no-redeclare");
    const loop = join(dir, "loop.ts");
    writeFileSync(loop, readFileSync(loop, "utf8").replace("let day", "const day"));
    expect(check().stdout).not.toContain("eslint(prefer-const)");
  });

  test("an empty test body goes red and a real test stays green", () => {
    const dir = repo({
      "eslint.config.js": `import base from "${join(import.meta.dirname, "..", "config", "eslint.js")}";\nexport default base;\n`,
      "a.test.ts": 'test("x", () => {});\n',
      "b.test.ts": 'test("x", () => { expect(1).toBe(1); });\n',
      // Every file the other checks count as a test, and a call two members deep.
      "c.spec.ts": 'it("x", () => {});\n',
      "tests/d.ts": 'test("x", () => {});\n',
      "e2e/e.js": 'test("x", () => {});\n',
      "f.test.ts": 'test.concurrent.only("x", () => {});\n',
      "g.ts": "const unusedThing = 1;\nexport {};\n",
      // Bun's global is known in a script, where typescript-eslint leaves no-undef on.
      "h.mjs": "console.log(Bun.version);\n",
    });
    const eslint = join(import.meta.dirname, "..", "node_modules", ".bin", "eslint");
    const r = spawnSync(eslint, ["."], { cwd: dir, encoding: "utf8", env: untyped });
    expect(r.status).toBe(1);
    for (const file of ["a.test.ts", "c.spec.ts", "tests/d.ts", "e2e/e.js", "f.test.ts"])
      expect(r.stdout).toContain(file);
    expect(r.stdout).not.toContain("b.test.ts");
    expect(r.stdout).not.toContain("g.ts");
    expect(r.stdout).not.toContain("h.mjs");
  });

  test("expect().rejects and .resolves go red in a test", () => {
    const dir = repo({
      "eslint.config.js": `import base from "${join(import.meta.dirname, "..", "config", "eslint.js")}";\nexport default base;\n`,
      "a.test.ts": 'test("x", async () => { await expect(Promise.reject(1)).rejects.toBe(1); });\n',
      "b.test.ts":
        'test("x", async () => { await expect(Promise.resolve(1)).resolves.not.toBe(2); });\n',
      "c.test.ts": 'test("x", async () => { expect(await Promise.resolve(1)).toBe(1); });\n',
    });
    const eslint = join(import.meta.dirname, "..", "node_modules", ".bin", "eslint");
    const r = spawnSync(eslint, ["."], { cwd: dir, encoding: "utf8", env: untyped });
    expect(r.stdout).toContain("a.test.ts");
    expect(r.stdout).toContain("b.test.ts");
    expect(r.stdout).not.toContain("c.test.ts");
    expect(r.stdout).toContain("await rejection() from @hackersandwizards/scaffolding/rejection");
  });

  test("the astro preset parses an .astro file's TypeScript with its own typescript-eslint", () => {
    // A folder with no node_modules: eslint-plugin-astro looks for the parser from the working
    // directory, where an isolated install of the consumer holds none.
    const dir = temp();
    write(dir, {
      "eslint.config.js": `export { default } from "${join(import.meta.dirname, "..", "config", "eslint-astro.js")}";\n`,
      "a.astro":
        "---\nconst a: number = 1;\n---\n<p>{a}</p>\n<script>\n  const b: number = 2;\n  console.log(b);\n</script>\n",
    });
    const eslint = join(import.meta.dirname, "..", "node_modules", ".bin", "eslint");
    const r = spawnSync(eslint, ["a.astro"], { cwd: dir, encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
    const config = jsonObject(
      spawnSync(eslint, ["--print-config", "a.astro"], { cwd: dir, encoding: "utf8" }).stdout,
    );
    expect(config.processor).toMatch(/^scaffolding\/astro@/);
  });

  test("Astro templates keep syntax checks and a script's real project types reach typed lint", () => {
    const dir = repo({
      ".oxlintrc.json": JSON.stringify(oxlintTemplate),
      "eslint.config.js": `export { default } from "${join(import.meta.dirname, "../config/eslint-astro.js")}";\n`,
      "tsconfig.json":
        '{"compilerOptions":{"strict":true,"module":"ESNext","moduleResolution":"bundler","lib":["ESNext"],"paths":{"@fixture/*":["./src/*"]}}}\n',
      "src/later.ts": "export const later = async () => 1;\n",
      "src/probe.astro": `---\u00a0
const label = "one";
debugger;
const Element = Fragment;
---
<Element>{(() => { debugger; return label; })()}</Element>
<script define:vars={{label}}>
  console.log(label.toUpperCase());
</script>
<script>
  import { later } from "./later";
  import { later as aliasedLater } from "@fixture/later";
  debugger;
  later();
  aliasedLater();
  console.log(1,\u00a02);
  const dialog = document.querySelector("dialog");
  dialog?.showModal();
  dialog?.nonexistent();
</script>
<script>
  const dialog = document.querySelector("dialog");
  dialog?.showModal();
  const _mode: ScrollRestoration = "manual";
</script>
<script>console.log(1,\u00a02);</script><p>\u00a0</p>
<script type="application/json">{\u00a0"x":1}</script>
`,
    });
    install(dir);
    const eslint = join(import.meta.dirname, "..", "node_modules", "eslint", "bin", "eslint.js");
    const ox = spawnSync(
      process.execPath,
      ["--no-env-file", join(import.meta.dirname, "../lib/oxlint.ts"), "-f", "json"],
      { cwd: dir, encoding: "utf8" },
    );
    expect(ox.stderr).toBe("");
    expect(ox.status).toBe(1);
    const diagnostics = jsonObject(ox.stdout).diagnostics as {
      code: string;
      labels: [{ span: { line: number } }];
    }[];
    expect(
      diagnostics
        .map(
          ({
            code,
            labels: [
              {
                span: { line },
              },
            ],
          }) => [line, code],
        )
        .sort(),
    ).toEqual([
      [1, "eslint(no-irregular-whitespace)"],
      [13, "eslint(no-debugger)"],
      [16, "eslint(no-irregular-whitespace)"],
      [26, "eslint(no-irregular-whitespace)"],
      [3, "eslint(no-debugger)"],
    ]);
    for (const env of [{ ...process.env, SCAFFOLDING_LINT_UNTYPED: "" }, untyped]) {
      const run = spawnSync(process.execPath, ["--bun", eslint, "src/probe.astro"], {
        cwd: dir,
        encoding: "utf8",
        env,
      });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(1);
      expect(run.stdout).toMatch(/6:\d+ .*no-debugger/);
      expect(run.stdout).not.toMatch(/(?:3:1|13:3) .*no-debugger/);
      expect(run.stdout.match(/\d+:\d+ .*no-irregular-whitespace/g)).toEqual([
        expect.stringMatching(/^26:39 /),
        expect.stringMatching(/^27:34 /),
      ]);
      expect(run.stdout).not.toContain("no-undef");
      if (env.SCAFFOLDING_LINT_UNTYPED) expect(run.stdout).not.toContain("no-floating-promises");
      else {
        expect(run.stdout).toMatch(/14:3 .*@typescript-eslint\/no-floating-promises/);
        expect(run.stdout).toMatch(/15:3 .*@typescript-eslint\/no-floating-promises/);
        expect(run.stdout).toMatch(/19:3 .*@typescript-eslint\/no-unsafe-call/);
        expect(run.stdout).not.toMatch(/^\s+(?:8|18|23):\d+ .*no-unsafe/m);
      }
    }
  });

  test("Astro frontmatter uses nested project types and reports original positions", () => {
    const dir = repo({
      "eslint.config.js": `export { default } from "${join(import.meta.dirname, "../config/eslint-astro.js")}";\n`,
      "tsconfig.json": '{"compilerOptions":{"strict":true,"paths":{"@props":["./wrong.ts"]}}}',
      "wrong.ts": "export interface Props { load: () => string }\n",
      "app/tsconfig.json":
        '{"extends":"../tsconfig.json","compilerOptions":{"paths":{"@props":["./Props.astro"]}},"include":[".astro/types.d.ts","**/*"]}',
      "app/.astro/types.d.ts":
        "declare namespace App { interface Locals { load: () => Promise<string> } }\n",
      "app/Props.astro": "---\nexport interface Props { load: () => Promise<string> }\n---\n",
      "app/Explicit.astro": [
        "\uFEFF---",
        'import type { Props } from "@props";',
        'const label = "🌱"; Astro.props.load();',
        "  Astro.locals.load();",
        "---",
        "{label}",
      ].join("\r\n"),
      "app/[slug].astro": `---
import type { ComponentProps } from "astro/types";
import Card from "fixture-card/entry";
export function getStaticPaths() {
  const card: ComponentProps<typeof Card> = { load: () => Promise.resolve("entry") };
  return [{ params: { slug: "start" }, props: { card } }];
}
Astro.props.card.load();
const slug = Astro.params.slug.toUpperCase();
---
{(() => { Promise.resolve(0); return slug; })()}
<script>
  Promise.resolve(0);
</script>
`,
      "node_modules/fixture-card/package.json":
        '{"name":"fixture-card","exports":{"./entry":"./Card.astro"}}',
      "node_modules/fixture-card/Card.astro":
        "---\ninterface Props { load: () => Promise<string> }\n---\n",
    });
    symlinkSync(
      join(import.meta.dirname, "../node_modules/astro"),
      join(dir, "node_modules/astro"),
    );
    const eslint = join(import.meta.dirname, "../node_modules/eslint/bin/eslint.js");
    for (const env of [{ ...process.env, SCAFFOLDING_LINT_UNTYPED: "" }, untyped]) {
      const run = spawnSync(process.execPath, ["--bun", eslint, "app", "-f", "json"], {
        cwd: dir,
        encoding: "utf8",
        env,
      });
      expect(run.stderr).toBe("");
      const results = JSON.parse(run.stdout) as {
        filePath: string;
        messages: {
          ruleId: string;
          line: number;
          column: number;
          endLine: number;
          endColumn: number;
        }[];
      }[];
      const findings = results.flatMap(({ filePath, messages }) =>
        messages.map(({ ruleId, line, column, endLine, endColumn }) => [
          relative(realpathSync(dir), filePath),
          ruleId,
          line,
          column,
          endLine,
          endColumn,
        ]),
      );
      const floating = "@typescript-eslint/no-floating-promises";
      expect(run.status).toBe(env.SCAFFOLDING_LINT_UNTYPED ? 0 : 1);
      expect(findings).toEqual(
        env.SCAFFOLDING_LINT_UNTYPED
          ? []
          : [
              ["app/Explicit.astro", floating, 3, 21, 3, 40],
              ["app/Explicit.astro", floating, 4, 3, 4, 23],
              ["app/[slug].astro", floating, 13, 3, 13, 22],
              ["app/[slug].astro", floating, 8, 1, 8, 25],
            ],
      );
    }
  });
});

// Stand-ins for brand's tokens.json values the shell's layout reads, as brand v2.4.0 has them.
const BRAND_TOKENS = {
  "--container-measure": "33em",
  "--spacing-app-header":
    "calc(var(--spacing-strip) + var(--spacing-header-row) + 1px + env(safe-area-inset-top))",
  "--spacing-strip": "3px",
  "--spacing-header-row": "3.5rem",
  "--radius-pill": "9999px",
};

describe("catalog", () => {
  // The tests build and serve a copy of test/fixture's own files, one per run, where lint and
  // format never read, so a stopped run's output reaches neither them nor the next run. Its
  // configs import ../../../catalog, which the link beside the copy keeps.
  let fixture = "";
  const astro = join(import.meta.dirname, "..", "node_modules", ".bin", "astro");
  beforeAll(() => {
    const work = temp(cache);
    fixture = join(work, "test", "fixture");
    const source = join(import.meta.dirname, "fixture");
    const own = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
    for (const file of spawnSync("git", own, { cwd: source, encoding: "utf8" }).stdout.split("\0"))
      if (file) cpSync(join(source, file), join(fixture, file));
    symlinkSync(join(import.meta.dirname, "..", "catalog"), join(work, "catalog"));
    // The package the fixture's homeCss names, for every test that builds or serves the fixture.
    write(join(fixture, "catalog", "node_modules", "@acme", "ui"), {
      "package.json": JSON.stringify({
        name: "@acme/ui",
        version: "1.2.3",
        exports: { "./ui.css": "./ui.css" },
      }),
      "ui.css": ".acme-ui{color:red}\n",
    });
  });
  test("a build left in the copy is a file the gate's lint and format skip", () => {
    const left = join(fixture, "catalog", "custom", "_astro", "x.js");
    write(dirname(left), { "x.js": "a;b  ;\n" });
    const run = (...args: string[]) =>
      spawnSync("bun", ["--bun", ...args, left], {
        cwd: join(import.meta.dirname, ".."),
        encoding: "utf8",
      });
    const lint = run("eslint");
    expect(lint.status).toBe(0);
    expect(lint.stdout).toContain("File ignored");
    expect(
      run("prettier", "--check", "--log-level", "warn", "--no-error-on-unmatched-pattern"),
    ).toMatchObject({
      status: 0,
      stdout: "",
      stderr: "",
    });
  });
  test("catalogPath: the root, or /catalog/ beside the site's own home; dev drops the base", () => {
    expect(catalogPath({ base: "/s", pages: ["types", "about.astro"] })).toBe("/s/");
    for (const page of ["index.astro", "index.html.ts", "index", "[...slug].astro"])
      expect(catalogPath({ base: "/s/", pages: [page] })).toBe("/s/catalog/");
    expect(catalogPath({ base: "/s", pages: ["[slug].astro", "indexes"], dev: true })).toBe("/");
    expect(catalogPath({ base: "/s", pages: ["index.astro"], dev: true })).toBe("/catalog/");
  });

  test("brandFallbacks: brand's token value replaces or adds a var()'s fallback, nested var()s filled", () => {
    const tokens = {
      "--a": "calc(var(--b) + 1px)",
      "--b": "3px",
      "--c": "color-mix(in srgb, var(--a, var(--b)) 5%, white)",
      "--loop": "var(--loop)",
    };
    const css =
      ".x{a:var(--a);b:var( --b , calc(1px + var(--q)));c:var(--n, var(--b));d:var(--c);e:var(--z, 1px);f:var(--loop)}";
    expect(brandFallbacks(css, tokens)).toBe(
      ".x{a:var(--a, calc(var(--b, 3px) + 1px));b:var(--b, 3px);c:var(--n, var(--b, 3px));d:var(--c, color-mix(in srgb, var(--a, var(--b)) 5%, white));e:var(--z, 1px);f:var(--loop, var(--loop))}",
    );
    expect(brandFallbacks(css, {})).toBe(css);
    expect(() => brandFallbacks(".x{a:var(--b, calc(1px}", tokens)).toThrow("no closing");
    // brand-value() is brand's literal, never a var() a scale redefines; without brand, the var().
    expect(brandFallbacks(".x{a:brand-value(--b);b:brand-value( --n )}", tokens)).toBe(
      ".x{a:3px;b:var(--n)}",
    );
    expect(() => brandFallbacks(".x{a:brand-value(--a)}", tokens)).toThrow("no fixed value");
    expect(() => brandFallbacks(".x{a:brand-value(--b, 1px)}", tokens)).toThrow("one custom");
  });

  test("rewriteRoute: an Astrobook route without a place for an edit fails rather than skip it", () => {
    const route = [
      "import { parseStoryDefaultExport, parseStoryNamedExport } from 'astrobook/client';",
      "const { decorators, args } = parseStoryNamedExport(m, './a.stories.ts', 'One');",
      "---",
      "<StoryPage story={'a'} hasSidebar={true}>",
      "{isAstroComponent ? <m.default.component {...args} /> : <m.default.component {...args} client:load />}",
      "",
    ].join("\n");
    const out = rewriteRoute("stories/a.astro", route, true);
    expect(out).toContain('import "virtual:scaffolding/catalog-css/stories";');
    expect(out).toContain("Astro.locals.hwCatalogLead = args?.lead;");
    expect(out).not.toContain("client:load");
    expect(rewriteRoute("dashboard/a.astro", route, false)).toContain("client:load");
    // A state's page draws the bar instead of Astrobook's sidebar; a state alone has none anyway.
    expect(rewriteRoute("dashboard/a.astro", route, false)).toContain("hasSidebar={false}");
    expect(out).toContain("hasSidebar={true}");
    expect(() =>
      rewriteRoute("dashboard/a.astro", route.replace("hasSidebar={true}", ""), false),
    ).toThrow(/sidebar/);
    expect(rewriteRoute("stories/a.astro", `${route}${route.split("---")[1]}`, true)).not.toContain(
      "client:load",
    );
    expect(rewriteRoute("stories/a.astro", out!, true)).toBeUndefined();
    const drifted = route.replace(" client:load />", " client:visible />");
    expect(rewriteRoute("stories/a.astro", drifted, false)).toContain("client:visible");
    expect(() => rewriteRoute("stories/a.astro", drifted, true)).toThrow(/client:load/);
    expect(() =>
      rewriteRoute("stories/a.astro", route.replace("'astrobook/client'", "'x'"), false),
    ).toThrow(/CSS import/);
    expect(() => rewriteRoute("other/a.astro", route, false)).toThrow(/CSS import/);
  });

  test("loadRoute reads a route another process is writing again until it is whole", async () => {
    const dir = temp();
    mkdirSync(join(dir, "stories"));
    const file = join(dir, "stories", "a.astro");
    const route = [
      "import { parseStoryDefaultExport, parseStoryNamedExport } from 'astrobook/client';",
      "const { decorators, args } = parseStoryNamedExport(m, './a.stories.ts', 'One');",
      "",
    ].join("\n");
    // Another process's Astrobook has truncated the file and writes it 50 ms later.
    writeFileSync(file, "");
    setTimeout(() => writeFileSync(file, route), 50);
    expect(await loadRoute(file, "stories/a.astro", false)).toContain(
      "virtual:scaffolding/catalog-css/stories",
    );
    // The file on disk stays Astrobook's.
    expect(readFileSync(file, "utf8")).toBe(route);
    writeFileSync(file, "");
    expect(await rejection(loadRoute(file, "stories/a.astro", false, 100))).toContain("CSS import");
  });

  test(
    "the preset builds the shell's home into the repository's dist/",
    async () => {
      const dist = join(fixture, "dist");
      const build = (args: string[] = [], env: Record<string, string> = {}, root = "catalog") =>
        spawnSync(astro, ["build", "--root", root, ...args], {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, CI: "", ...env },
        });
      const r = build();
      expect(r.status).toBe(0);
      // No page of its own at pages/index: the catalog is the site's home.
      const home = readFileSync(join(dist, "index.html"), "utf8");
      // `nav`: an href from "/" counts from the base, the current item links to /catalog/, which
      // forwards to the home.
      expect(home).toContain(
        '<header class="fx-header"><a href="/">Fx</a><div class="hw-header-nav hw-catalog-nav"><nav class="hw-header-nav" aria-label="Main" data-hw-catalogs><a class="hw-header-link" href="/">Site</a><a class="hw-header-link" href="/catalog/" aria-current="page">Fx</a><a class="hw-header-link" href="https://example.com/other/">Other</a><a class="hw-header-link" href="//example.com/far/">Far</a></nav></div></header>',
      );
      expect(home).toContain(
        '<p class="hw-catalog-provenance"><span>fx catalog/stories ·</span> <span>@acme/ui v1.2.3 ·</span> <span>3 components ·</span> <span>24 states</span></p>',
      );
      // An app with no stories folder builds a home without the line that would count nothing.
      const empty = join(fixture, "empty");
      write(empty, {
        "astro.config.mjs":
          'import { catalog } from "../../../catalog/index.ts";\nexport default { integrations: [catalog({ product: "Fx", css: [], lead: "", header: { component: "../catalog/Header.astro" } })] };\n',
      });
      expect(build([], {}, "empty").status).toBe(0);
      const emptyHome = readFileSync(join(empty, "dist", "index.html"), "utf8");
      expect(emptyHome).toContain('class="hw-catalog-lead"');
      expect(emptyHome).not.toContain("hw-catalog-provenance");
      // The admin hub serves only on this machine: a built page carries no link to it.
      expect(home).not.toContain("admin.localhost");
      expect(home.indexOf(">Types <")).toBeLessThan(home.indexOf(">Parts <"));
      // The rail names every element under its group, linked to the state its tile draws.
      expect(home).toMatch(
        /<ul class="hw-catalog-names"><li><a href="\/dashboard\/Parts\/box-parts\/two\/">Box parts<\/a>/,
      );
      // `previewStates` in order: the first a component has wins.
      expect(home).toContain('<a href="/dashboard/Parts/many-parts/block-image/">Many parts</a>');
      // A frame names its page in data-src: the shell's script loads it once the tile nears the view.
      expect(home).toContain('data-src="/stories/Types/box-types/two/"');
      expect(home).not.toMatch(/<iframe[^>]* src=/);
      expect(readdirSync(join(dist, "stories/Parts/box-parts"))).toEqual(["one", "two"]);
      // `previewSize` per group: a Types tile draws its frame whole at 1440 x 900, a Parts tile at
      // three quarters.
      expect(home).toContain(
        'data-frame-width="1440" style="aspect-ratio:1440/900"><iframe data-src="/stories/Types/box-types/two/"',
      );
      expect(home).toMatch(/<span class="hw-catalog-preview"><iframe data-src="\/stories\/Parts\//);
      // The shell's own card, pill and rail (brand's search field and navigation list) carry
      // data-hw-shell, for brand-elements to skip.
      expect(home).toContain(
        '<aside class="hw-catalog-rail" data-hw-shell><div class="hw-search"><input class="hw-field hw-catalog-search" type="search"',
      );
      expect(home).toContain('<nav class="hw-nav" aria-label="Groups">');
      expect(home).toContain('<a class="hw-card hw-catalog-tile" data-hw-shell href=');
      expect(home).toContain('<span class="hw-pill" data-tone="neutral" data-hw-shell>');
      expect(readFileSync(join(dist, "fx.txt"), "utf8")).toBe("fx\n");
      const page = (p: string) => readFileSync(join(dist, p, "index.html"), "utf8");
      // No page carries a robots tag; the shell draws dense, a story at `storyScale`, and every page but a
      // state alone turns with the theme toggle.
      const root = (html: string) =>
        html.match(/Object\.assign\(document\.documentElement\.dataset,(\{.*?\})\);/)?.[1];
      expect(root(home)).toBe('{"hwScale":"dense","hwNight":""}');
      expect(root(page("dashboard/Parts/box-parts/two"))).toBe('{"hwScale":"screen","hwNight":""}');
      expect(root(page("stories/Parts/box-parts/two"))).toBe('{"hwScale":"screen"}');
      const robots = /<meta\b[^>]*\bname\s*=\s*["']?robots\b/i;
      for (const p of [
        "",
        "dashboard/Parts/box-parts/two",
        "stories/Parts/box-parts/two",
        "catalog",
        "catalog/dashboard/Parts/box-parts/two",
      ])
        expect(page(p)).not.toMatch(robots);
      for (const p of ["", "dashboard/Parts/box-parts/two", "stories/Parts/box-parts/two"])
        expect(page(p)).toContain('<meta name="description" content="Lead.">');
      // Each state's page and state alone has a title of its own, the home the catalog's.
      expect(page("")).toContain("<title>Fx catalog</title>");
      for (const p of ["dashboard/Parts/box-parts/one", "stories/Parts/box-parts/one"])
        expect(page(p)).toContain("<title>Box parts: One – Fx catalog</title>");
      expect(page("dashboard/Parts/many-parts/two-pd-fs")).toContain(
        "<title>Many parts: Two PDFs – Fx catalog</title>",
      );
      // A state whose args carry a lead describes itself by it.
      for (const p of ["dashboard/Parts/box-parts/one", "stories/Parts/box-parts/one"])
        expect(page(p)).toContain('<meta name="description" content="The first box.">');
      // Without a `site` the canonical URL is root-relative; a state alone names the state's page.
      const links = (html: string, rel: string) =>
        [...html.matchAll(new RegExp(`<link rel="${rel}" href="([^"]*)"`, "g"))].map((m) => m[1]);
      expect(links(home, "canonical")).toEqual(["/"]);
      for (const p of ["dashboard/Parts/box-parts/two", "stories/Parts/box-parts/two"])
        expect(links(page(p), "canonical")).toEqual(["/dashboard/Parts/box-parts/two/"]);
      // `htmlClass` on every page, before the body draws.
      for (const p of ["", "dashboard/Parts/box-parts/two", "stories/Parts/box-parts/two"])
        expect(page(p)).toContain(
          'document.documentElement.classList.add(...["fx-root","fx-two"]);',
        );
      // The shell's stylesheet inlines: a linked one is one more render-blocking request.
      for (const p of ["", "dashboard/Parts/box-parts/two"])
        expect(page(p)).toContain("#astrobook-sidebar");
      expect(page("stories/Parts/box-parts/two")).not.toContain("#astrobook-sidebar");
      // The skeleton's preview script, as a repository's root runs it.
      const { serve } = await import("../lib/serve.ts");
      const preview = await serve(
        ["sh", "-c", `cd ${fixture} && ${PREVIEW} --host "$HOST" --port "$PORT"`],
        {
          env: {
            PATH: `${join(import.meta.dirname, "..", "node_modules", ".bin")}:${process.env.PATH}`,
          },
        },
      );
      try {
        expect((await fetch(`${preview.url}/stories/Parts/box-parts/two/`)).status).toBe(200);
      } finally {
        preview.stop();
      }
      // The shell paints the ground from brand's role or token; the fixture's home loads no token,
      // so the page sets them. A story's own stylesheet still wins on a state's page.
      const served = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (req) => {
          const { pathname } = new URL(req.url);
          return new Response(
            Bun.file(join(dist, pathname, pathname.endsWith("/") ? "index.html" : "")),
          );
        },
      });
      const painted = await browse(`${served.url}`);
      try {
        await painted.until(
          `document.readyState === "complete" && !!document.querySelector(".hw-catalog")`,
        );
        // A sized tile fitted while the search hid it is fitted again once the search shows it.
        const sized = `document.querySelector(".hw-catalog-preview[data-frame-width] iframe").style.transform`;
        await painted.until(`${sized}.startsWith("scale(") && ${sized} !== "scale(0)"`);
        const fitted = await painted.evaluate(sized);
        const search = (q: string) =>
          `(() => { const s = document.querySelector(".hw-catalog-search"); s.value = ${JSON.stringify(q)}; s.dispatchEvent(new Event("input", { bubbles: true })); })()`;
        await painted.evaluate(search("many"));
        await painted.evaluate(`dispatchEvent(new Event("resize"))`);
        // The resize has fitted the hidden tile: at scale 0, or marked to fit once shown.
        await painted.until(
          `document.querySelector(".hw-catalog-preview[data-frame-width]").hasAttribute("data-hw-unfit") || ${sized} === "scale(0)"`,
        );
        await painted.evaluate(search(""));
        expect(await painted.evaluate(sized)).toBe(fitted);
        const ground = () =>
          painted.evaluate(`getComputedStyle(document.documentElement).backgroundColor`);
        expect(await ground()).toBe("rgba(0, 0, 0, 0)");
        for (const [step, colour] of [
          [
            `document.documentElement.style.setProperty("--color-bg", "rgb(1, 2, 3)")`,
            "rgb(1, 2, 3)",
          ],
          [
            `document.documentElement.style.setProperty("--background", "rgb(4, 5, 6)")`,
            "rgb(4, 5, 6)",
          ],
          [
            `document.head.insertAdjacentHTML("beforeend", "<style>@layer base { html { background: rgb(7, 8, 9); } }</style>")`,
            "rgb(7, 8, 9)",
          ],
        ] as const) {
          await painted.evaluate(step);
          expect(await ground()).toBe(colour);
        }
        const ink = `document.documentElement.style.setProperty("--color-ink", "rgb(1, 2, 3)")`;
        // The shell's text reads brand's role or token, and a state's page whose CSS holds no reset
        // still draws the bar in the ink and its controls 28 px high.
        await painted.evaluate(ink);
        expect(await painted.evaluate(`getComputedStyle(document.body).color`)).toBe(
          "rgb(1, 2, 3)",
        );
        await painted.evaluate(`location.href = "/dashboard/Parts/box-parts/two/"`);
        await painted.until(
          `location.pathname.startsWith("/dashboard/") && document.readyState === "complete" && !!document.querySelector(".hw-catalog-bar")`,
        );
        await painted.evaluate(ink);
        expect(
          await painted.evaluate(
            `[".hw-catalog-bar > a", ".hw-catalog-bar button", ".hw-catalog-tool", ".hw-catalog-step", ".hw-catalog-states li a"].map((s) => { const e = document.querySelector(s); return [getComputedStyle(e).color, e.getBoundingClientRect().height]; })`,
          ),
        ).toEqual(Array(5).fill(["rgb(1, 2, 3)", 28]));
        // The story keeps the focus ring's room, brand's --hw-focus-room, clear of <main>'s scroll
        // box and of the bar, which stays flush with <main>. The shell retypes none of brand's values:
        // without the room, the width and offset alone give none.
        const room = (set: string) =>
          painted.evaluate(
            `(() => { document.documentElement.setAttribute("style", ${JSON.stringify(set)}); const [m, b, s] = ["main", ".hw-catalog-bar", ".box"].map((q) => document.querySelector(q).getBoundingClientRect()); return [b.left - m.left, b.width - m.width, b.top - m.top, s.left - m.left, s.top - b.bottom, m.right - s.right]; })()`,
          );
        expect(await room("--hw-focus-width: 4px; --hw-focus-offset: 3px")).toEqual([
          0, 0, 0, 0, 0, 0,
        ]);
        expect(await room("--hw-focus-room: 9px")).toEqual([0, 0, 0, 9, 9, 9]);
        // A story's own padding on <main> wins over the room.
        await painted.evaluate(
          `document.head.insertAdjacentHTML("beforeend", "<style>main { padding: 2rem; }</style>")`,
        );
        expect(((await room("")) as number[])[3]).toBe(32);
        // The bar takes brand's stored theme and writes its toggle there, so a choice made on the
        // repository's own pages carries into the catalog and back.
        await painted.evaluate(`localStorage.setItem("theme", "dark"); location.reload()`);
        await painted.until(
          `document.readyState === "complete" && !!document.querySelector("[data-hw-theme]")`,
        );
        expect(
          await painted.evaluate(
            `[document.documentElement.dataset.theme, document.querySelector("[data-hw-theme]").getAttribute("aria-pressed")]`,
          ),
        ).toEqual(["dark", "true"]);
        await painted.evaluate(`document.querySelector("[data-hw-theme]").click()`);
        expect(
          await painted.evaluate(
            `[document.documentElement.dataset.theme, localStorage.getItem("theme")]`,
          ),
        ).toEqual(["light", "light"]);
        // A flip by anything else on <html>, brand's switch in the header among them, is stored and
        // followed by Astrobook's toggle.
        await painted.evaluate(`document.documentElement.dataset.theme = "dark"`);
        await painted.until(`localStorage.getItem("theme") === "dark"`);
        expect(await painted.evaluate(`window.astroThemeToggle.getTheme()`)).toBe("dark");
        // A state alone in the window keeps the room inside Astrobook's scrolling <main> too. It draws
        // in the day theme whatever the reader chose, as a tile's frame does, and keeps the choice.
        await painted.evaluate(
          `localStorage.setItem("theme", "dark"); localStorage.setItem("theme-toggle", "dark"); location.href = "/stories/Parts/box-parts/two/"`,
        );
        await painted.until(
          `location.pathname.startsWith("/stories/") && document.readyState === "complete" && !!document.querySelector(".box")`,
        );
        expect(
          await painted.evaluate(
            `(() => { document.documentElement.style.setProperty("--hw-focus-room", "6px"); const [m, s] = ["main", ".box"].map((q) => document.querySelector(q).getBoundingClientRect()); return [s.left - m.left, s.top - m.top, document.documentElement.dataset.hwAlone]; })()`,
          ),
        ).toEqual([6, 6, ""]);
        expect(
          await painted.evaluate(
            `[document.documentElement.dataset.theme, document.documentElement.classList.contains("dark"), localStorage.getItem("theme"), localStorage.getItem("theme-toggle")]`,
          ),
        ).toEqual(["light", false, "dark", "dark"]);
        // It turns at no flip of its own, so it leaves the stored choice alone: a tile's frame
        // writing it would turn every other page back.
        await painted.evaluate(
          `localStorage.setItem("theme", "light"); document.documentElement.dataset.theme = "dark"`,
        );
        await Bun.sleep(100);
        expect(await painted.evaluate(`localStorage.getItem("theme")`)).toBe("light");
      } finally {
        painted.close();
        void served.stop(true);
      }
      // Every page of the catalog's former place forwards to its page at the root.
      expect(page("catalog/dashboard/Parts/box-parts/two")).toContain(
        'http-equiv="refresh" content="0; url=/dashboard/Parts/box-parts/two/"',
      );
      expect(page("catalog")).toContain('content="0; url=/"');
      const state = page("dashboard/Parts/box-parts/two");
      // Each page's own styles: its <style> blocks and the stylesheets it links.
      const styles = (html: string) =>
        [
          ...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g).map((m) => m[1]),
          ...html
            .matchAll(/<link rel="stylesheet" href="\/_astro\/([^"]+)"/g)
            .map((m) => readFileSync(join(dist, "_astro", m[1]!), "utf8")),
        ].join("");
      expect(state).toContain('<meta name="fx-head" content="repository">');
      expect(styles(state)).toMatch(
        /#astrobook-sidebar,\s*astrobook-sidebar-resize-handle\s*\{\s*display:\s*none\s*!important/,
      );
      // A state's page takes the header's, the bar's and the repository's CSS, `css` without a
      // `dashboardCss`; a state alone only the repository's; the home the header's and the shell's,
      // and of the repository's only `homeCss`.
      const [stateCss, aloneCss, homeCss] = [state, page("stories/Parts/box-parts/two"), home].map(
        styles,
      );
      for (const rule of [".fx-header{display:flex}", ".hw-catalog-bar{", ".box{color:teal}"])
        expect(stateCss).toContain(rule);
      expect(aloneCss).toContain(".box{color:teal}");
      for (const rule of [".fx-header{", "hw-catalog-bar", "hw-catalog-nav", "astrobook-sidebar,"])
        expect(aloneCss).not.toContain(rule);
      expect(homeCss).toContain(".fx-header{display:flex}");
      expect(homeCss).toContain(".hw-catalog-grid{");
      expect(homeCss).not.toContain(".box{");
      expect(homeCss).toContain(".acme-ui{");
      const barOf = (html: string) =>
        html.match(/<template id="hw-catalog-bar">([\s\S]*?)<\/template>/)?.[1] ?? "";
      const bar = barOf(state);
      // A state's page carries the header above the bar, the current item marked as the place, not
      // the page.
      expect(
        bar.startsWith(
          '<div data-hw-catalog-top><header class="fx-header"><a href="/">Fx</a><div class="hw-header-nav hw-catalog-nav"><nav class="hw-header-nav" aria-label="Main" data-hw-catalogs><a class="hw-header-link" href="/">Site</a><a class="hw-header-link" href="/catalog/" aria-current="true">Fx</a><a class="hw-header-link" href="https://example.com/other/">Other</a><a class="hw-header-link" href="//example.com/far/">Far</a></nav></div></header></div><nav class="hw-catalog-bar"',
        ),
      ).toBe(true);
      expect(bar).toContain('<nav class="hw-catalog-bar" aria-label="Catalog">');
      expect(bar).toContain('<a href="/catalog/"><span aria-hidden="true">');
      expect(bar).toMatch(/Parts \/ <strong>Box parts<\/strong>/);
      expect(bar).toContain('<button type="button" data-hw-theme aria-pressed="false">');
      expect(bar).toMatch(
        /<a class="hw-catalog-tool" href="\/stories\/Parts\/box-parts\/two\/">\s*Open this state alone\s*<\/a>/,
      );
      expect(bar).toContain('<ul aria-label="States">');
      expect(bar).toMatch(/href="\/dashboard\/Parts\/box-parts\/one\/">One/);
      expect(bar).toMatch(/href="\/dashboard\/Parts\/box-parts\/two\/" aria-current="page">Two/);
      expect(bar).toContain(
        '<a class="hw-catalog-step" rel="prev" href="/dashboard/Parts/box-parts/one/"',
      );
      // A step with nowhere to go is no anchor: Lighthouse's crawlable-anchors fails one without href.
      expect(bar).toContain(
        '<button class="hw-catalog-step" type="button" disabled aria-label="Next state">',
      );
      const first = barOf(page("dashboard/Parts/box-parts/one"));
      expect(first).toContain(
        '<button class="hw-catalog-step" type="button" disabled aria-label="Previous state">',
      );
      expect(first).toContain(
        '<a class="hw-catalog-step" rel="next" href="/dashboard/Parts/box-parts/two/"',
      );
      expect(`${bar}${first}`).not.toMatch(/<a(?![^>]*href)[^>]*>/);
      expect(bar).toContain("2 of 2");
      // Above 12 states a menu replaces the chips, grouped by a word three names share.
      const many = barOf(page("dashboard/Parts/many-parts/block-image"));
      expect(many).not.toContain("<ul");
      expect(many).toContain(
        '<optgroup label="Block"><option value="/dashboard/Parts/many-parts/block-code/">Block code</option><option value="/dashboard/Parts/many-parts/block-image/" selected>Block image</option>',
      );
      expect(many).toContain(
        '<optgroup label="Theme"><option value="/dashboard/Parts/many-parts/accent-theme/">Accent theme</option>',
      );
      expect(many).toContain(
        '</optgroup><option value="/dashboard/Parts/many-parts/angebot-ohne-preise/">Angebot ohne Preise</option>',
      );
      // A camelCase state reads in sentence case, an acronym kept; a name with underscores keeps its
      // author's case. Either way the first word is capitalised.
      expect(many).toMatch(/many-parts\/density-on-pdf\/">Density on PDF</);
      expect(many).toMatch(/">Folie 35 Eine Woche zum</);
      expect(many).toMatch(/">In German</);
      // So a German noun after the first word needs an underscore name.
      expect(many).toMatch(/">Mit impressum</);
      expect(many).toMatch(/">Primary on night</);
      // A plural acronym and a listed name with inner capitals stay whole.
      expect(many).toMatch(/many-parts\/two-pd-fs\/">Two PDFs</);
      expect(many).toMatch(/many-parts\/loading-git-hub\/">Loading GitHub</);
      expect(state).toContain("if (top) main.before(top);");
      expect(page("stories/Parts/box-parts/two")).not.toContain('id="hw-catalog-bar"');
      expect(home).not.toContain('id="hw-catalog-bar"');
      // `serverOnly`: no state's route keeps Astrobook's client:load branch, so no story module
      // ships to the browser.
      expect(globSync("_astro/*.stories.*", { cwd: dist })).toEqual([]);
      // `copy`: each match at its own path, the rest of the folder left out.
      expect(readdirSync(join(dist, "assets")).sort()).toEqual(["logo.svg", "nested"]);
      expect(readFileSync(join(dist, "assets/nested/page.css"), "utf8")).toBe(
        "a {\n  color: red;\n}\n",
      );
      // A package path lands at that path, resolved through the package's exports.
      expect(readFileSync(join(dist, "@acme/fx/logos/logo.svg"), "utf8")).toBe(
        readFileSync(join(fixture, "assets/logo.svg"), "utf8"),
      );
      // A project Pages site sets Astro's base: the links and the header's default follow it.
      expect(build(["--base", "/fx"]).status).toBe(0);
      const based = readFileSync(join(dist, "index.html"), "utf8");
      expect(based).toContain(
        '<header class="fx-header"><a href="/fx/">Fx</a><div class="hw-header-nav hw-catalog-nav"><nav class="hw-header-nav" aria-label="Main" data-hw-catalogs><a class="hw-header-link" href="/fx/">Site</a><a class="hw-header-link" href="/fx/catalog/" aria-current="page">Fx</a><a class="hw-header-link" href="https://example.com/other/">Other</a><a class="hw-header-link" href="//example.com/far/">Far</a></nav></div></header>',
      );
      expect(based).toContain('data-src="/fx/stories/Types/box-types/two/"');
      expect(page("catalog/stories/Types/box-types/two")).toContain(
        'url=/fx/stories/Types/box-types/two/"',
      );
      // A base ending in /catalog mounts the catalog under a host with its own home: no forwarding
      // pages and no public/, which the host serves.
      expect(build(["--base", "/catalog"]).status).toBe(0);
      const mountedHome = readFileSync(join(dist, "index.html"), "utf8");
      expect(mountedHome).toContain('data-src="/catalog/stories/Types/box-types/two/"');
      // Its home reads /catalog/ already: the current item links there, not to /catalog/catalog/.
      expect(mountedHome).toContain(
        '<a class="hw-header-link" href="/catalog/" aria-current="page">Fx</a>',
      );
      expect(page("dashboard/Parts/box-parts/two")).toContain(
        '<a href="/catalog/"><span aria-hidden',
      );
      expect(existsSync(join(dist, "catalog"))).toBe(false);
      expect(existsSync(join(dist, "fx.txt"))).toBe(false);
      // An outDir the config sets stays; only Astro's default moves to the repository's dist/.
      const custom = join(fixture, "catalog", "custom");
      expect(build(["--outDir", "./custom"]).status).toBe(0);
      expect(existsSync(join(custom, "index.html"))).toBe(true);
      // A story link ends where Astro writes its page: no slash where a page is a file of its own,
      // unless the site asks for one.
      const files = join(fixture, "catalog", "files.config.mjs");
      for (const [slash, end] of [
        ["ignore", ""],
        ["always", "/"],
      ]) {
        writeFileSync(
          files,
          `import config from "./astro.config.mjs";\nexport default { ...config, trailingSlash: "${slash}", build: { format: "file" } };\n`,
        );
        expect(build(["--config", "files.config.mjs"]).status).toBe(0);
        expect(readFileSync(join(dist, "index.html"), "utf8")).toContain(
          `<li><a href="/dashboard/Parts/box-parts/two${end}">Box parts</a>`,
        );
      }
      rmSync(files);
      // A build with a file-URL assetsPrefix is opened from disk: every link to a page or file of the
      // build names its file by file URL, the home's frames, a copied file and a state menu's options
      // included; a link outside the build stays, and no page forwards from /catalog/.
      const disk = join(fixture, "catalog", "disk.config.mjs");
      writeFileSync(
        disk,
        `import config from "./astro.config.mjs";\nexport default { ...config, build: { assetsPrefix: ${JSON.stringify(pathToFileURL(`${dist}/`).href)} } };\n`,
      );
      expect(build(["--config", "disk.config.mjs"]).status).toBe(0);
      const onDisk = readFileSync(join(dist, "index.html"), "utf8");
      const at = (p: string) => pathToFileURL(join(dist, p)).href;
      expect(onDisk).toContain(
        `<iframe data-src="${at("stories/Types/box-types/two/index.html")}"`,
      );
      expect(onDisk).toContain(
        `<li><a href="${at("dashboard/Parts/box-parts/two/index.html")}">Box parts</a>`,
      );
      expect(onDisk).toContain(`<a href="${at("index.html")}">Fx</a>`);
      expect(onDisk).toContain(
        `<a class="hw-header-link" href="${at("index.html")}" aria-current="page">Fx</a>`,
      );
      expect(onDisk).toContain('href="https://example.com/other/"');
      expect(onDisk).not.toMatch(/\s(href|src|data-src)="\/(?!\/)/);
      expect(page("dashboard/Parts/box-parts/two")).toContain(
        `href="${at("stories/Parts/box-parts/two/index.html")}">Open this state alone`,
      );
      expect(onDisk).toContain(`<link rel="icon" href="${at("assets/logo.svg")}">`);
      // A build opened from disk is never published, and a file URL names the build machine.
      expect(onDisk).not.toContain('rel="canonical"');
      expect(page("dashboard/Parts/many-parts/block-image")).toContain(
        `<option value="${at("dashboard/Parts/many-parts/block-code/index.html")}">Block code</option>`,
      );
      expect(existsSync(join(dist, "catalog"))).toBe(false);
      rmSync(disk);
      // A redirect from "/" would take the catalog's place: the build fails and says why.
      const redirecting = join(fixture, "catalog", "redirecting.config.mjs");
      writeFileSync(
        redirecting,
        'import config from "./astro.config.mjs";\nexport default { ...config, redirects: { "/": "/x/" } };\n',
      );
      const refused = build(["--config", "redirecting.config.mjs"]);
      expect(refused.status).not.toBe(0);
      expect(`${refused.stdout}${refused.stderr}`).toContain("`redirects` leaves out");
      rmSync(redirecting);
      // A package path outside the package's exports fails the build by name.
      const unexported = join(fixture, "catalog", "unexported.config.mjs");
      writeFileSync(
        unexported,
        'import config from "./astro.config.mjs";\nimport { catalog } from "../../../catalog/index.ts";\nexport default { ...config, integrations: [catalog({ product: "Fx", css: [], lead: "", copy: ["@acme/fx/assets/skip.txt"] })] };\n',
      );
      const missing = build(["--config", "unexported.config.mjs"]);
      expect(`${missing.stdout}${missing.stderr}`).toContain(
        "catalog copy: @acme/fx/assets/skip.txt is no file in the exports of @acme/fx",
      );
      rmSync(unexported);
      // A `nav.current` naming no item fails the build by name.
      const misnamed = join(fixture, "catalog", "misnamed.config.mjs");
      writeFileSync(
        misnamed,
        'import config from "./astro.config.mjs";\nimport { catalog } from "../../../catalog/index.ts";\nexport default { ...config, integrations: [catalog({ product: "Fx", css: [], lead: "", nav: { items: [{ name: "Fx", href: "/" }], current: "Fxx" } })] };\n',
      );
      const misnamedBuild = build(["--config", "misnamed.config.mjs"]);
      expect(misnamedBuild.status).not.toBe(0);
      expect(`${misnamedBuild.stdout}${misnamedBuild.stderr}`).toContain(
        'catalog nav: current "Fxx" names no item',
      );
      rmSync(misnamed);
      const variant = (name: string, options: string) => {
        const file = join(fixture, "catalog", `${name}.config.mjs`);
        writeFileSync(
          file,
          `import config from "./astro.config.mjs";\nimport { catalog } from "../../../catalog/index.ts";\nexport default { ...config, integrations: [catalog({ product: "Fx", css: [], lead: "", header: { component: "./Header.astro" }, ${options} })] };\n`,
        );
        const result = build(["--config", `${name}.config.mjs`]);
        rmSync(file);
        return result;
      };
      // `dashboardCss` replaces `css` on a state's page; a state alone keeps `css`.
      const dash = join(fixture, "catalog", "dash.css");
      writeFileSync(dash, ".dash{color:red}\n");
      expect(variant("dashed", 'css: ["./fx.css"], dashboardCss: ["./dash.css"]').status).toBe(0);
      const dashCss = styles(page("dashboard/Parts/box-parts/two"));
      expect(dashCss).toContain(".dash{color:red}");
      expect(dashCss).not.toContain(".box{");
      expect(styles(page("stories/Parts/box-parts/two"))).toContain(".box{color:teal}");
      rmSync(dash);
      // Without brand, hw-focus-ring in `htmlClass` loads no focus ring and fails no build.
      expect(variant("ringless", 'htmlClass: ["hw-focus-ring"]').status).toBe(0);
      // A `previewSize` key naming no group fails the build by name: a renamed group would fall back
      // to the small fitted view unseen.
      const stale = variant("stale", "previewSize: { Parts: [1, 1], Pieces: [1440, 900] }");
      expect(stale.status).not.toBe(0);
      expect(`${stale.stdout}${stale.stderr}`).toContain(
        'catalog previewSize: "Pieces" names no story group (Parts, Types)',
      );
      // A `previewStates` entry naming no story's state fails the build by name: a renamed state
      // would leave every tile on another state unseen.
      const unknown = variant("unknown", 'previewStates: ["two", "gone"]');
      expect(unknown.status).not.toBe(0);
      expect(`${unknown.stdout}${unknown.stderr}`).toContain(
        'catalog previewStates: "gone" names no story\'s state',
      );
      // `themeToggle: false`: the bar offers no dark theme.
      expect(variant("light", "themeToggle: false").status).toBe(0);
      expect(page("dashboard/Parts/box-parts/two")).not.toContain(
        '<button type="button" data-hw-theme',
      );
      expect(root(page("dashboard/Parts/box-parts/two"))).toBe("{}");
      // With a `site` the canonical URL is absolute, under the base.
      expect(build(["--site", "https://fx.example", "--base", "/fx"]).status).toBe(0);
      expect(page("stories/Parts/box-parts/two")).toContain(
        '<link rel="canonical" href="https://fx.example/fx/dashboard/Parts/box-parts/two/"',
      );
      expect(page("")).toContain('<link rel="canonical" href="https://fx.example/fx/"');
      // Where the repository resolves brand, every page carries brand's favicon ahead of the
      // repository's head, whose own link then wins; without brand the shell writes none.
      expect(build().status).toBe(0);
      expect(links(page(""), "icon")).toEqual(["/assets/logo.svg"]);
      // Without brand the bar reads the repository's own --text-ui.
      const brandless = globSync("**/*.{css,html}", { cwd: dist })
        .map((f) => readFileSync(join(dist, f), "utf8"))
        .join("");
      expect(brandless.match(/\.hw-catalog-bar\{[^}]*\}/)?.[0]).toContain(
        "font:500 1rem var(--font-sans);font-size:var(--text-ui);line-height:var(--text-ui--line-height);",
      );
      expect(brandless).not.toContain("brand-value");
      // The shell's home holds no foundations: no group of its own. A home with some draws them as
      // Foundations; beside a stories folder of that name the build fails, and a home of whitespace
      // and a comment leaves the folder the one group (compressHTML off, as in the repositories).
      expect(home).not.toContain('id="foundations"');
      const catalogDir = join(fixture, "catalog");
      const homed = join(catalogDir, "homed.config.mjs");
      const ownHome = join(catalogDir, "OwnHome.astro");
      const folder = join(catalogDir, "stories", "Foundations");
      const ownHomeWith = (body: string) =>
        write(catalogDir, {
          "homed.config.mjs":
            'import config from "./astro.config.mjs";\nimport { catalog } from "../../../catalog/index.ts";\nexport default { ...config, compressHTML: false, integrations: [catalog({ product: "Fx", css: [], lead: "", header: { component: "./Header.astro" }, home: "./OwnHome.astro" })] };\n',
          "OwnHome.astro": `---\nimport Home from "../../../catalog/Home.astro";\n---\n\n<Home>${body}</Home>\n`,
        });
      ownHomeWith("<p>Tokens</p>");
      expect(build(["--config", "homed.config.mjs"]).status).toBe(0);
      expect(readFileSync(join(dist, "index.html"), "utf8")).toContain('id="foundations"');
      write(folder, {
        "Tokens.stories.js":
          'import Box from "../../Box.astro";\n\nexport default { component: Box };\nexport const One = { args: { label: "one" } };\n',
      });
      const twice = build(["--config", "homed.config.mjs"]);
      expect(twice.status).not.toBe(0);
      expect(`${twice.stdout}${twice.stderr}`).toContain(
        'catalog: the groups "Foundations" and "Foundations" both draw as #foundations',
      );
      ownHomeWith("\n  <!-- none yet -->\n");
      expect(build(["--config", "homed.config.mjs"]).status).toBe(0);
      const folderOnly = readFileSync(join(dist, "index.html"), "utf8");
      expect(folderOnly.match(/id="foundations"/g)).toHaveLength(1);
      expect(folderOnly).not.toContain('class="hw-catalog-text"');
      rmSync(folder, { recursive: true });
      rmSync(homed);
      rmSync(ownHome);
      // Without `nav`, the header lists brand's catalogs.json, the one named as `product` current.
      const brand = join(fixture, "node_modules", "@hackersandwizards", "brand");
      const navless = join(fixture, "catalog", "navless.config.mjs");
      write(brand, {
        "package.json": JSON.stringify({
          exports: {
            "./catalogs.json": "./expert/catalogs.json",
            "./tokens.json": "./generated/tokens.json",
            "./logos/*": "./logos/*",
            "./header.css": "./header.css",
            "./layers.css": "./tokens/layers.css",
            "./night.css": "./night.css",
            "./elements/*": "./elements/*",
            "./expert/components/*": "./expert/components/*",
          },
        }),
        "logos/favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
        // Over Vite's 4 KB inlining limit, so `?url` gives a file as with brand's own logo.
        "logos/lockup-screen.svg": `<svg xmlns="http://www.w3.org/2000/svg"><!--${"x".repeat(5000)}--></svg>`,
        "logos/night-logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"><!--${"y".repeat(5000)}--></svg>`,
        "header.css": "",
        "tokens/layers.css": "@layer properties, theme, base, components, utilities;\n",
        "night.css": "",
        "elements/focus.css": ".hw-focus-ring :focus-visible{outline:3px solid purple}\n",
        "expert/components/ThemeToggle.astro":
          '<button id="theme-toggle" class="hw-header-link" data-icon type="button">T</button>\n',
        "expert/components/AppHeader.astro":
          '---\nimport lockup from "../../logos/lockup-screen.svg?url";\nimport night from "../../logos/night-logo.svg?url";\n---\n\n<header class="hw-header"><img class="hw-header-logo" src={lockup} alt="" /><img src={night} alt="" loading="lazy" /><slot /></header>\n',
        "expert/catalogs.json": JSON.stringify([
          { name: "Other", href: "https://example.com/other/" },
          { name: "Fx", href: "https://example.com/fx/" },
        ]),
        // Values none of the shell's own: each var() naming one takes it as its fallback.
        "generated/tokens.json": JSON.stringify({
          tokens: {
            "--container-measure": "31em",
            "--text-page": "1.7rem",
            "--spacing-app-header": "calc(var(--spacing-strip) + 2rem)",
            "--spacing-strip": "5px",
            "--radius-pill": "77px",
            "--text-ui": "0.9rem",
            "--text-ui--line-height": "1.55",
          },
        }),
      });
      writeFileSync(
        navless,
        'import config from "./astro.config.mjs";\nimport { catalog } from "../../../catalog/index.ts";\nexport default { ...config, integrations: [catalog({ product: "Fx", css: [], lead: "" })] };\n',
      );
      expect(build(["--config", "navless.config.mjs"]).status).toBe(0);
      const branded = readFileSync(join(dist, "index.html"), "utf8");
      const sheets = [
        branded,
        ...globSync("**/*.css", { cwd: dist }).map((f) => readFileSync(join(dist, f), "utf8")),
      ]
        .join("")
        .replace(/,\s+/g, ",");
      for (const fallback of [
        "var(--container-measure,31em)",
        "var(--text-page,1.7rem)",
        "var(--spacing-app-header,calc(var(--spacing-strip,5px) + 2rem))",
        "var(--radius-pill,77px)",
      ])
        expect(sheets).toContain(fallback);
      // The bar's size is brand's unscaled UI step.
      expect(sheets).toMatch(
        /\.hw-catalog-bar\{[^}]*font:500 1rem var\(--font-sans\);[^}]*font-size:\.9rem;line-height:1\.55;/,
      );
      expect(sheets).not.toContain("brand-value");
      // brand's layer order follows the ground's.
      expect(branded).toContain(
        "<style>@layer hw-catalog-ground;@layer properties, theme, base, components, utilities;@layer hw-catalog-ground{",
      );
      expect(branded).toContain(
        '<nav class="hw-header-nav" aria-label="Main" data-hw-catalogs><a class="hw-header-link" href="https://example.com/other/">Other</a><a class="hw-header-link" href="/catalog/" aria-current="page">Fx</a></nav>',
      );
      // brand's theme switch ends the header on the home and a state's page, whose bar then offers
      // none of its own; brand's focus ring is on <html> unless `htmlClass` says otherwise.
      const brandedState = readFileSync(
        join(dist, "dashboard/Parts/box-parts/two/index.html"),
        "utf8",
      );
      for (const html of [branded, brandedState]) {
        expect(html).toMatch(/<\/nav><button id="theme-toggle"[^>]*>T<\/button><\/div>/);
        expect(root(html)).toContain('"hwNight":""');
        expect(html).toContain('classList.add(...["hw-focus-ring"])');
      }
      expect(brandedState).not.toContain('<button type="button" data-hw-theme');
      // A state's page holds its header in a <template> the preload scanner skips and puts it into
      // <main> as the parser reaches it. The head's script asks for the logo before the rest of the
      // document arrives, and leaves a logo marked lazy to the browser. The server holds the rest
      // until the logo is whole in the page, 8 s at most: a lazy logo asked for in the same loop
      // has reached the server by then, and a loaded machine cannot reorder the two.
      const order: string[] = [];
      let release = () => {};
      const released = new Promise<void>((done) => (release = done));
      const slow = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          const { pathname } = new URL(req.url);
          order.push(pathname);
          const path = join(dist, decodeURIComponent(pathname));
          if (!pathname.endsWith("/")) return new Response(Bun.file(path));
          const html = readFileSync(join(path, "index.html"), "utf8");
          const cut = html.indexOf("</head>");
          return new Response(
            new ReadableStream({
              async start(stream) {
                stream.enqueue(new TextEncoder().encode(html.slice(0, cut)));
                await Promise.race([released, Bun.sleep(8000)]);
                order.push("rest sent");
                stream.enqueue(new TextEncoder().encode(html.slice(cut)));
                stream.close();
              },
            }),
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        },
      });
      const browsing = await browse(`${slow.url}dashboard/Parts/box-parts/two/`);
      try {
        await browsing.until(
          `performance.getEntriesByType("resource").some((e) => e.name.includes("lockup-screen"))`,
        );
        release();
        await browsing.until(`document.querySelector("img.hw-header-logo")?.complete`);
        expect(order).toContain("rest sent");
        const early = order.slice(0, order.indexOf("rest sent")).join();
        expect(early).toContain("lockup-screen");
        expect(early).not.toContain("night-logo");
      } finally {
        browsing.close();
        void slow.stop(true);
      }
      rmSync(navless);
      // `htmlClass` holding brand's hw-focus-ring loads brand's focus ring on every page; without
      // the class no page loads it. A `themeToggle` of false leaves brand's switch out of the
      // header and offers the bar's none either.
      expect(variant("unswitched", "themeToggle: false").status).toBe(0);
      expect(page("")).not.toContain('id="theme-toggle"');
      expect(page("dashboard/Parts/box-parts/two")).not.toContain(
        '<button type="button" data-hw-theme',
      );
      const ring = ".hw-focus-ring :focus-visible{outline:3px solid purple}";
      const ringPages = ["", "dashboard/Parts/box-parts/two", "stories/Parts/box-parts/two"];
      expect(variant("ringoff", "htmlClass: []").status).toBe(0);
      for (const p of ringPages) expect(styles(page(p))).not.toContain(ring);
      expect(variant("ringed", 'htmlClass: ["hw-focus-ring"]').status).toBe(0);
      for (const p of ringPages) expect(styles(page(p))).toContain(ring);
      // A list naming focus.css itself loads it once, ahead of the list's other sheets.
      expect(
        variant(
          "ringtwice",
          'css: ["./fx.css", "@hackersandwizards/brand/elements/focus.css"], htmlClass: ["hw-focus-ring"]',
        ).status,
      ).toBe(0);
      const alone = styles(page("stories/Parts/box-parts/two"));
      expect(alone.split(ring)).toHaveLength(2);
      expect(alone.indexOf(ring)).toBeLessThan(alone.indexOf(".box{color:teal}"));
      expect(build().status).toBe(0);
      for (const p of ["", "stories/Parts/box-parts/two"]) {
        const [icon, ...others] = links(page(p), "icon");
        expect(icon).toMatch(/^\/_astro\/favicon\..*\.svg$/);
        expect(others).toEqual(["/assets/logo.svg"]);
      }
      // The shell's type sizes are brand's tokens.json steps (brand v2.5.0), the focus ring's room is
      // brand's --hw-focus-room (v2.10.0).
      const brandPkg = join(brand, "package.json");
      writeFileSync(
        brandPkg,
        JSON.stringify({ ...JSON.parse(readFileSync(brandPkg, "utf8")), version: "2.9.0" }),
      );
      const older = build();
      expect(older.status).not.toBe(0);
      expect(older.stdout + older.stderr).toContain(
        "needs @hackersandwizards/brand v2.10.0 or later, installed is v2.9.0",
      );
      rmSync(join(fixture, "node_modules"), { recursive: true });
      // The build adds no robots tag to a page of the repository's own; one with a tag of its own and
      // an endpoint's file stay as written.
      const src = join(fixture, "catalog", "src");
      const pages = join(src, "pages");
      mkdirSync(join(pages, "catalog"), { recursive: true });
      const head = (body: string) =>
        `<html lang="en"><head><title>t</title>${body}</head><body></body></html>\n`;
      writeFileSync(join(pages, "own.astro"), head(""));
      writeFileSync(join(pages, "kept.astro"), head('<meta name="robots" content="index">'));
      writeFileSync(
        join(pages, "raw.html.ts"),
        'export const GET = () => new Response("<html><head></head></html>");\n',
      );
      // An endpoint whose page should not be indexed writes its own tag.
      writeFileSync(
        join(pages, "tagged.html.ts"),
        `export const GET = () => new Response('<html><head><meta name="robots" content="noindex"></head></html>');\n`,
      );
      expect(build().status).toBe(0);
      expect(readFileSync(join(dist, "tagged.html"), "utf8")).toBe(
        '<html><head><meta name="robots" content="noindex"></head></html>',
      );
      expect(page("own")).toContain("<head><title>");
      expect(page("own")).not.toMatch(robots);
      expect(page("kept")).toMatch(robots);
      expect(page("kept")).toContain('<meta name="robots" content="index">');
      expect(page("kept")).not.toContain("noindex");
      expect(readFileSync(join(dist, "raw.html"), "utf8")).toBe("<html><head></head></html>");
      writeFileSync(join(pages, "headless.astro"), "<p>no head</p>\n");
      // A page without <head> builds.
      expect(build().status).toBe(0);
      expect(page("headless")).toContain("no head");
      expect(page("headless")).not.toMatch(robots);
      rmSync(join(pages, "headless.astro"));
      // A page of the site's own at /catalog/ beside a root catalog keeps its place: the catalog
      // links its home.
      writeFileSync(join(pages, "catalog", "index.astro"), head("<p>site catalog page</p>"));
      expect(build().status).toBe(0);
      expect(page("catalog")).toContain("site catalog page");
      expect(page("")).toContain('<a class="hw-header-link" href="/" aria-current="page">Fx</a>');
      rmSync(join(pages, "catalog", "index.astro"));
      // A site with a home page of its own keeps the catalog at /catalog/; no page gets a robots tag.
      writeFileSync(join(pages, "index.astro"), head("<p>site home</p>"));
      writeFileSync(join(pages, "catalog", "extra.astro"), head(""));
      expect(build().status).toBe(0);
      expect(page("").includes("site home")).toBe(true);
      expect(page("")).not.toMatch(robots);
      expect(page("own")).not.toMatch(robots);
      expect(page("catalog/extra")).not.toMatch(robots);
      expect(page("catalog")).toContain("fx catalog/stories");
      expect(page("catalog/dashboard/Parts/box-parts/two")).toContain('href="/catalog/"');
      rmSync(src, { recursive: true });
      // In CI a copied file still a Git LFS pointer fails the build; locally it passes.
      const ci = build([], { CI: "true" });
      expect(ci.status).not.toBe(0);
      expect(`${ci.stdout}${ci.stderr}`).toContain(
        "catalog copy: still Git LFS pointers: assets/nested/lfs.woff2",
      );
    },
    limit(60_000),
  );

  // A repository's head sets attributes on <html> and runs page scripts: Astrobook's client router
  // swaps pages in place, which drops both until a reload.
  test(
    "dev serves `copy`, and a click in the bar loads the next state in full",
    async () => {
      const { serve } = await import("../lib/serve.ts");
      // Modules at paths a forward would take, as a site whose Astro root holds catalog/ serves its
      // catalog/Head.astro and catalog/stories/ under the base /catalog.
      for (const dir of ["fx", "catalog/stories"]) {
        mkdirSync(join(fixture, "catalog", dir), { recursive: true });
        writeFileSync(join(fixture, "catalog", dir, "mod.css"), "a {\n  color: red;\n}\n");
      }
      // A page of the site's own at /catalog/, written before dev starts: dev reads no page added
      // under node_modules, where the copy lies.
      const src = join(fixture, "catalog", "src");
      mkdirSync(join(src, "pages", "catalog"), { recursive: true });
      writeFileSync(join(src, "pages", "catalog", "index.astro"), "<p>site catalog page</p>\n");
      write(join(fixture, "catalog"), {
        "virtual.config.mjs": `import config from "./astro.config.mjs";
export default { ...config, vite: { plugins: [{
  name: "fixture-virtual",
  enforce: "post",
  resolveId: (id) => id === "virtual:fixture" ? "\\0constructor" : undefined,
  load: (id) => id === "\\0constructor" ? 'export default "from the fixture plugin";' : undefined,
}] } };`,
        "src/pages/virtual.astro":
          '---\nimport value from "virtual:fixture";\n---\n<p>{value}</p>\n',
      });
      // ASTRO_DEV_BACKGROUND=1, as the dev script in docs/catalog.md: under an agent astro dev otherwise moves
      // into the background and resolves --root from inside the folder.
      // Astro disables its dev server middleware when the child inherits VITEST from the worker.
      const server = await serve(
        [
          "sh",
          "-c",
          `unset VITEST && cd '${fixture}' && exec '${astro}' dev --root catalog --config virtual.config.mjs --base /fx --host $HOST --port $PORT`,
        ],
        { env: { ASTRO_DEV_BACKGROUND: "1" }, timeoutMs: 30_000 },
      );
      let page: Awaited<ReturnType<typeof browse>> | undefined;
      try {
        const logo = await fetch(`${server.url}/assets/logo.svg`);
        expect(logo.status).toBe(200);
        const served = await fetch(`${server.url}/@acme/fx/logos/logo.svg`);
        expect(served.status).toBe(200);
        expect(served.headers.get("content-type")).toBe("image/svg+xml");
        expect(logo.headers.get("content-type")).toBe("image/svg+xml");
        const css = await fetch(`${server.url}/assets/nested/page.css`);
        expect(css.headers.get("content-type")).toBe("text/css");
        expect(await css.text()).toBe("a {\n  color: red;\n}\n");
        writeFileSync(join(fixture, "assets/nested/data.constructor"), "own file");
        const data = await fetch(`${server.url}/assets/nested/data.constructor`);
        expect.soft(data.headers.get("content-type")).toBe("application/octet-stream");
        expect.soft(await data.text()).toBe("own file");
        const virtual = await fetch(`${server.url}/virtual/`);
        expect.soft(virtual.status).toBe(200);
        expect.soft(await virtual.text()).toContain("from the fixture plugin");
        expect((await fetch(`${server.url}/assets/skip.txt`)).status).toBe(404);
        // Each pattern is globbed once; a file added since is found by a second glob.
        writeFileSync(join(fixture, "assets", "late.svg"), "<svg/>");
        expect((await fetch(`${server.url}/assets/late.svg`)).status).toBe(200);
        // A state's page has its own title in dev too.
        expect(
          await (await fetch(`${server.url}/fx/dashboard/Parts/box-parts/one/`)).text(),
        ).toContain("<title>Box parts: One – Fx catalog</title>");
        // `admin`: in dev the header links the repository's page in the local hub; the fixture's
        // repository is this checkout.
        expect(await (await fetch(`${server.url}/`)).text()).toMatch(
          /<a class="hw-header-link" href="http:\/\/admin\.localhost:4329\/scaffolding\/dashboard"[^>]*><span aria-hidden="true"[^>]*>←&nbsp;<\/span>Admin hub<\/a>/,
        );

        // Dev serves at the root: the old /catalog/ path and the Pages base forward there.
        for (const [old, to] of [
          ["/catalog/dashboard/Parts/box-parts/two?x", "/dashboard/Parts/box-parts/two?x"],
          // The base drops, and the site's own page at /catalog/ keeps its place.
          ["/fx/catalog/", "/catalog/"],
          ["/catalog/stories/%E2%82%AC", "/stories/%E2%82%AC"],
          ["/fx//evil.example/x", "/evil.example/x"],
        ]) {
          const r = await fetch(`${server.url}${old}`, { redirect: "manual" });
          expect([r.status, r.headers.get("location")]).toEqual([307, to]);
        }
        // A file under the root is a module, not a page: it stays where it is.
        for (const path of ["/fx/mod.css", "/catalog/stories/mod.css"])
          expect((await fetch(`${server.url}${path}`, { redirect: "manual" })).status).toBe(200);
        // A page of the site's own under /catalog/ is not one of the catalog's former pages.
        expect(
          (await fetch(`${server.url}/catalog/print/`, { redirect: "manual" })).status,
        ).not.toBe(307);
        // Nor is a page of the site's own at /catalog/ itself, as in the build.
        const own = await fetch(`${server.url}/catalog/`, { redirect: "manual" });
        expect([own.status, (await own.text()).includes("site catalog page")]).toEqual([200, true]);
        page = await browse(`${server.url}/dashboard/Parts/box-parts/two`);
        const { evaluate, until } = page;
        await until(`document.readyState === "complete" && !!document.body.dataset.fxRan`);
        await evaluate(
          `document.querySelector('.hw-catalog-bar a[href$="/box-parts/one/"]').click()`,
        );
        await until(`location.pathname.endsWith("/one/") && document.readyState === "complete"`);
        await new Promise((r) => setTimeout(r, 500));
        const after = await evaluate(
          `JSON.stringify([document.documentElement.dataset.fxHead, document.documentElement.dataset.hwScale, document.body.dataset.fxRan, !!document.querySelector("main .hw-catalog-bar"), document.body.dataset.fxBar])`,
        );
        expect(JSON.parse(String(after))).toEqual([
          "repository",
          "screen",
          "/dashboard/Parts/box-parts/one/",
          true,
          // The story's own inline script found the bar: it stood above the story from the start.
          "above",
        ]);
        // A key a story's own window listener takes stays with the story.
        await evaluate(
          `window.addEventListener("keydown", (e) => e.preventDefault(), { once: true }); document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))`,
        );
        await new Promise((r) => setTimeout(r, 500));
        expect(String(await evaluate("location.pathname")).endsWith("/one/")).toBe(true);
        // The right arrow key steps to the next state.
        await evaluate(
          `document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))`,
        );
        await until(`location.pathname.endsWith("/two/") && document.readyState === "complete"`);
      } finally {
        page?.close();
        server.stop();
        rmSync(src, { recursive: true });
      }
    },
    limit(90_000),
  );

  // 40 tiles, each framing a page whose spec text sits above the element it marks as its preview.
  test(
    "tile frames load after the first paint and near the view, and draw only the marked preview",
    async () => {
      const { renderCatalog } = await import("../catalog/render.ts");
      const shellCss = brandFallbacks(
        readFileSync(join(import.meta.dirname, "..", "catalog", "catalog.css"), "utf8"),
        BRAND_TOKENS,
      );
      // An even tile marks a full-width wrapper of its own ground around a smaller box, an odd one a
      // box with a ground of its own.
      const box =
        '<span class="box" style="display:inline-block;width:200px;height:100px;background:rgb(1, 2, 3)">x</span>';
      const story = (i: number) =>
        `<!doctype html><html style="background:#fff"><body><main><p class="spec">Spec text</p>${
          i % 2
            ? box.replace('class="box"', 'class="box" data-hw-preview')
            : `<div data-hw-preview><div>${box}</div></div>`
        }</main></body></html>`;
      const home = (path: string, srcdoc: boolean) =>
        `<!doctype html><html><head><style>${shellCss}</style></head><body>${renderCatalog({
          title: "t",
          lead: "l",
          provenance: "p",
          groups: [
            {
              name: "Parts",
              items: Array.from({ length: 40 }, (_, i) => ({
                name: `x${i}`,
                href: `/x${i}`,
                frame: `/${path}/${i}`,
                frameSrcdoc: srcdoc,
              })),
            },
          ],
        })}</body></html>`;
      const asked: string[] = [];
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          const { pathname } = new URL(req.url);
          asked.push(pathname);
          const html = { headers: { "Content-Type": "text/html" } };
          if (pathname === "/home") return new Response(home("story", false), html);
          if (pathname === "/inline") return new Response(home("deny", true), html);
          // A site that refuses to be framed, as one sending X-Frame-Options DENY.
          const deny = pathname.startsWith("/deny/");
          return new Response(story(Number(pathname.split("/").pop())), {
            headers: { ...html.headers, ...(deny && { "X-Frame-Options": "DENY" }) },
          });
        },
      });
      const page = await browse("about:blank", ["--window-size=1280,800"]);
      try {
        const { ws, send, evaluate, until } = page;
        const failed: string[] = [];
        ws.addEventListener("message", (event) => {
          const m = jsonObject(String(event.data));
          if (m.method === "Network.loadingFailed")
            failed.push(String(member(m, "params", "errorText")));
        });
        await send("Network.enable");
        const frames = (prefix: string) => asked.filter((p) => p.startsWith(prefix)).length;
        await send("Page.navigate", { url: `${server.url}home` });
        const fitted = `(() => { const f = document.querySelector(".hw-catalog-preview iframe"); return !!f.contentDocument?.querySelector("[data-hw-preview]") && f.style.transform.includes("scale"); })()`;
        await until(`document.readyState === "complete" && ${fitted}`);
        await new Promise((r) => setTimeout(r, 1000));
        // Only the tiles in or near the view load: four rows of three at 1280 x 800, not all 40.
        const near = frames("/story/");
        expect(near).toBeGreaterThan(0);
        expect(near).toBeLessThan(20);
        // No frame starts before the first paint.
        const [paint, firstFrame] = (await evaluate(
          `[performance.getEntriesByName("first-paint")[0]?.startTime, Math.min(...performance.getEntriesByType("resource").filter((e) => e.initiatorType === "iframe").map((e) => e.startTime))]`,
        )) as [number, number];
        expect(paint).toBeGreaterThan(0);
        expect(firstFrame).toBeGreaterThanOrEqual(paint);
        // The marked element alone shows, centred in its tile on what it paints, on the page's ground
        // around it, white, even where it has a ground of its own; the frame's canvas is cleared.
        const fit = (tile: number) =>
          evaluate(`(() => {
        const p = document.querySelectorAll(".hw-catalog-preview")[${tile}], f = p.firstElementChild, d = f.contentDocument;
        const r = d.querySelector(".box").getBoundingClientRect();
        const [tx, ty, s] = f.style.transform.match(/-?[\\d.]+/g).map(Number);
        return { dx: tx + (r.left + r.width / 2) * s - p.clientWidth / 2, dy: ty + (r.top + r.height / 2) * s - p.clientHeight / 2,
          spec: getComputedStyle(d.querySelector(".spec")).visibility, preview: getComputedStyle(d.querySelector("[data-hw-preview]")).visibility, ground: p.style.background, canvas: getComputedStyle(d.documentElement).backgroundColor };
      })()`) as Promise<Record<string, number | string>>;
        for (const tile of [0, 1]) {
          const at = await fit(tile);
          expect(Math.abs(at.dx as number)).toBeLessThan(1);
          expect(Math.abs(at.dy as number)).toBeLessThan(1);
          expect([at.spec, at.preview, at.ground, at.canvas]).toEqual([
            "hidden",
            "visible",
            "rgb(255, 255, 255)",
            "rgba(0, 0, 0, 0)",
          ]);
        }
        // Scrolled to the end, the last tile loads.
        await evaluate(`document.querySelector(".hw-catalog-grid li:last-child").scrollIntoView()`);
        await until(
          `!!document.querySelector(".hw-catalog-grid li:last-child iframe").contentDocument?.querySelector("[data-hw-preview]")`,
        );
        expect(asked).toContain("/story/39");
        expect(failed).toEqual([]);
        // `frameSrcdoc`: a page that refuses framing draws from its HTML; no frame load starts, so
        // none is cancelled.
        await send("Page.navigate", { url: `${server.url}inline` });
        await until(`document.readyState === "complete" && ${fitted}`);
        await new Promise((r) => setTimeout(r, 1000));
        expect(frames("/deny/")).toBeGreaterThan(0);
        expect(frames("/deny/")).toBeLessThan(20);
        expect(
          await evaluate(
            `[...document.querySelectorAll(".hw-catalog-preview iframe")].some((f) => f.hasAttribute("src"))`,
          ),
        ).toBe(false);
        expect(failed).toEqual([]);
        // Behind another tab the page is hidden and never paints: every tile loads at once.
        await send("Target.createTarget", { url: "about:blank" });
        expect(await evaluate("document.hidden")).toBe(true);
        const before = frames("/story/");
        await send("Page.navigate", { url: `${server.url}home` });
        await until(`document.readyState === "complete"`);
        for (const end = Date.now() + 10_000; frames("/story/") - before < 40 && Date.now() < end;)
          await new Promise((r) => setTimeout(r, 100));
        expect(frames("/story/") - before).toBe(40);
      } finally {
        page.close();
        void server.stop(true);
      }
    },
    limit(60_000),
  );

  // os at 1440 x 913 after v5.7.1: the lead at brand's measure pushed the first group's top below a
  // third of the window, so the rail marked nothing on load.
  test(
    "the rail marks the first group at the top of the page, however tall the lead",
    async () => {
      const { renderCatalog } = await import("../catalog/render.ts");
      const shellCss = brandFallbacks(
        readFileSync(join(import.meta.dirname, "..", "catalog", "catalog.css"), "utf8"),
        BRAND_TOKENS,
      );
      const html = `<!doctype html><html><head><style>${shellCss}</style></head><body>${renderCatalog(
        {
          title: "t",
          lead: "word ".repeat(200),
          provenance: "p",
          groups: ["A", "B", "C", "D", "E"].map((name) => ({
            name,
            items: Array.from({ length: 12 }, (_, i) => ({
              name: `${name}${i}`,
              href: `/${name}${i}`,
            })),
          })),
        },
      )}</body></html>`;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }),
      });
      const page = await browse("about:blank");
      try {
        const { send, evaluate, until } = page;
        await send("Emulation.setDeviceMetricsOverride", {
          width: 1440,
          height: 913,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Page.navigate", { url: server.url.href });
        await until(`document.readyState === "complete"`);
        const scroller = `(() => { const m = document.querySelector("main"); return m && m.scrollHeight > m.clientHeight ? m : document.scrollingElement; })()`;
        const top = (g: string) => `document.getElementById("${g}").getBoundingClientRect().top`;
        const marked = `[...document.querySelectorAll(".hw-catalog-rail a[aria-current]")].map((a) => a.getAttribute("href")).join()`;
        expect(await evaluate(`${top("a")} > innerHeight / 3`)).toBe(true);
        await until(`${marked} === "#a"`);
        // Scrolled within the lead, no group has passed the third: the first stays marked.
        await evaluate(`${scroller}.scrollTop = 5`);
        await new Promise((r) => setTimeout(r, 300));
        expect(await evaluate(`${top("a")} > innerHeight / 3 && ${marked} === "#a"`)).toBe(true);
        // Scrolled, a group counts once its top passes a third of the window.
        await evaluate(`${scroller}.scrollTop += ${top("b")} - innerHeight / 3 + 2`);
        await until(`${marked} === "#b"`);
        await evaluate(`${scroller}.scrollTop = 0`);
        await until(`${marked} === "#a"`);
      } finally {
        page.close();
        void server.stop(true);
      }
    },
    limit(60_000),
  );

  // After v5.7.1's measure, consumers saw "… v2.3.1 · 4 / components · 17 states" and a second
  // line opening on a bare "·".
  test(
    "the provenance line wraps between parts, each separator with the part before it",
    async () => {
      const { renderCatalog } = await import("../catalog/render.ts");
      const shellCss = brandFallbacks(
        readFileSync(join(import.meta.dirname, "..", "catalog", "catalog.css"), "utf8"),
        BRAND_TOKENS,
      );
      const parts = [
        "certificate-verifier src/stories",
        "@hackersandwizards/brand v2.3.1",
        "4 components",
        "17 states",
      ];
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>${shellCss}</style></head><body>${renderCatalog(
        { title: "t", lead: "l", provenance: parts.join(" · "), groups: [] },
      )}</body></html>`;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }),
      });
      const page = await browse("about:blank");
      const provenance = `document.querySelector(".hw-catalog-provenance")`;
      // The line's text grouped by the top of each character's box, a pixel apart counting as one.
      const rows = `(() => {
      const p = ${provenance};
      const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const rows = new Map();
      for (let node; (node = walk.nextNode()); )
        for (let i = 0; i < node.length; i++) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getClientRects()[0];
          if (!rect) continue;
          const top = [...rows.keys()].find((t) => Math.abs(t - rect.top) < 1) ?? rect.top;
          rows.set(top, (rows.get(top) ?? "") + node.data[i]);
        }
      return [...rows].sort(([a], [b]) => a - b).map(([, text]) => text.trim());
    })()`;
      try {
        const { send, evaluate, until } = page;
        await send("Page.navigate", { url: server.url.href });
        await until(`document.readyState === "complete"`);
        const bad: string[] = [];
        let wrapped = 0;
        for (let width = 280; width <= 900; width += 10) {
          await send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 800,
            deviceScaleFactor: 1,
            mobile: false,
          });
          const shown = (await evaluate(rows)) as string[];
          if (shown.length > 1) wrapped++;
          if (
            shown.some((l) => l.startsWith("·")) ||
            parts.some((part) => !shown.some((l) => l.includes(part))) ||
            !(await evaluate(`(${provenance}).scrollWidth <= (${provenance}).clientWidth`))
          )
            bad.push(`${width}: ${shown.join(" / ")}`);
        }
        // A control: the sweep reaches widths where the line wraps.
        expect(wrapped).toBeGreaterThan(5);
        expect(bad).toEqual([]);
      } finally {
        page.close();
        void server.stop(true);
      }
    },
    limit(60_000),
  );

  test(
    "a sized tile honours the marked preview, a mark may name a part, a clipped box fits as clipped",
    async () => {
      const { renderCatalog } = await import("../catalog/render.ts");
      const shellCss = brandFallbacks(
        readFileSync(join(import.meta.dirname, "..", "catalog", "catalog.css"), "utf8"),
        BRAND_TOKENS,
      );
      const part =
        '<span class="part" style="display:inline-block;width:200px;height:100px;background:rgb(1, 2, 3)">x</span><span class="other">y</span>';
      const wide = 'style="width:5000px;height:100px;background:rgb(1, 2, 3)"';
      const clipping = 'style="overflow:hidden;width:300px"';
      const stories: { html: string; size?: [number, number] }[] = [
        { html: `<div data-hw-preview>${part}</div>`, size: [1440, 900] },
        { html: `<div data-hw-preview=".part">${part}</div>`, size: [1440, 900] },
        { html: `<div data-hw-preview=".part">${part}</div>` },
        { html: `<div data-hw-preview ${clipping}><div><div ${wide}></div></div></div>` },
        { html: `<div data-hw-preview=".part" ${clipping}><div class="part" ${wide}></div></div>` },
        { html: `<div data-hw-preview="1">${part}</div>` },
        { html: `<div data-hw-preview=".none">${part}</div>` },
      ];
      const home = `<!doctype html><html><head><style>${shellCss}</style></head><body>${renderCatalog(
        {
          title: "t",
          lead: "l",
          provenance: "p",
          groups: [
            {
              name: "Parts",
              items: stories.map(({ size }, i) => ({
                name: `x${i}`,
                href: `/x${i}`,
                frame: `/story/${i}`,
                frameSize: size,
              })),
            },
          ],
        },
      )}</body></html>`;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          const { pathname } = new URL(req.url);
          const body =
            pathname === "/home"
              ? home
              : `<!doctype html><html style="background:rgb(9, 9, 9)"><body><main><p class="spec">Spec text</p>${stories[Number(pathname.split("/").pop())]?.html}</main></body></html>`;
          return new Response(body, { headers: { "Content-Type": "text/html" } });
        },
      });
      const page = await browse(`${server.url}home`, ["--window-size=1280,1400"]);
      try {
        const { evaluate, until } = page;
        await until(
          `document.readyState === "complete" && document.querySelectorAll(".hw-catalog-preview iframe").length === ${stories.length} && [...document.querySelectorAll(".hw-catalog-preview iframe")].every((f) => f.contentDocument?.getElementById("hw-preview-only"))`,
        );
        const tile = (i: number) =>
          evaluate(`(() => {
        const p = document.querySelectorAll(".hw-catalog-preview")[${i}], f = p.firstElementChild, d = f.contentDocument;
        const shown = (s) => { const e = d.querySelector(s); return e && getComputedStyle(e).visibility; };
        return { w: f.style.width, h: f.style.height, t: f.style.transform, ground: p.style.background, canvas: getComputedStyle(d.documentElement).backgroundColor,
          spec: shown(".spec"), part: shown(".part"), other: shown(".other"), pw: p.clientWidth, ph: p.clientHeight };
      })()`) as Promise<Record<string, string | number>>;
        // A sized tile keeps its window and draws the mark alone, on the ground around it.
        const whole = await tile(0);
        expect([whole.w, whole.h]).toEqual(["1440px", "900px"]);
        expect(whole.t).toMatch(/^scale\([\d.]+\)$/);
        expect([whole.spec, whole.part, whole.other, whole.ground, whole.canvas]).toEqual([
          "hidden",
          "visible",
          "visible",
          "rgb(9, 9, 9)",
          "rgba(0, 0, 0, 0)",
        ]);
        // A mark holding a selector draws that part of it alone, sized or fitted.
        for (const i of [1, 2]) {
          const at = await tile(i);
          expect([at.spec, at.part, at.other]).toEqual(["hidden", "visible", "hidden"]);
        }
        // A value that is no selector, or selects nothing, draws the whole mark.
        for (const i of [5, 6]) {
          const at = await tile(i);
          expect([at.spec, at.part, at.other]).toEqual(["hidden", "visible", "visible"]);
        }
        // A clipping box bounds what the mark paints, inside it or around the part: 300 px, not 5000.
        for (const i of [3, 4]) {
          const clipped = await tile(i);
          const scale = Number(String(clipped.t).match(/scale\(([\d.]+)\)/)?.[1]);
          expect(scale).toBeCloseTo(
            Math.min(
              0.75,
              ((clipped.ph as number) - 16) / 100,
              ((clipped.pw as number) - 16) / 300,
            ),
            2,
          );
        }
      } finally {
        page.close();
        void server.stop(true);
      }
    },
    limit(60_000),
  );

  test("a group of markup draws it in place of tiles, without a count", async () => {
    const { renderCatalog } = await import("../catalog/render.ts");
    const html = renderCatalog({
      title: "t",
      lead: "l",
      provenance: "p",
      groups: [
        { name: "Parts", items: [{ name: "x", href: "/x" }] },
        { name: "Foundations", items: [], html: "<p>Tokens</p>" },
      ],
    });
    expect(html).toContain(
      '<li><a href="#foundations"><span>Foundations</span></a></li></ul></nav>',
    );
    expect(html).toContain(
      '</section><section class="hw-catalog-group" id="foundations"><h2>Foundations</h2><div class="hw-catalog-text"><p>Tokens</p></div></section></div>',
    );
  });

  test("a group of whitespace draws nothing; two groups under one anchor fail", async () => {
    const { renderCatalog } = await import("../catalog/render.ts");
    const base = { title: "t", lead: "l", provenance: "p" };
    const item = { name: "x", href: "/x" };
    const html = renderCatalog({
      ...base,
      groups: [
        { name: "Parts", items: [item] },
        { name: "Foundations", items: [], html: "\n  " },
      ],
    });
    expect(html).not.toContain("foundations");
    expect(() =>
      renderCatalog({
        ...base,
        groups: [
          { name: "Form Fields", items: [item] },
          { name: "form-fields", items: [item] },
        ],
      }),
    ).toThrow('catalog: the groups "Form Fields" and "form-fields" both draw as #form-fields');
  });

  test("the search finds a tile by its `search` words, which the tile does not show", async () => {
    const { renderCatalog } = await import("../catalog/render.ts");
    const html = renderCatalog({
      title: "t",
      lead: "l",
      provenance: "p",
      groups: [{ name: "Parts", items: [{ name: "Grid slide", href: "/x", search: "GridSlide" }] }],
    });
    expect(html).toContain('data-search="parts grid slide  gridslide"');
    expect(html).not.toContain(">GridSlide<");
  });

  test("group anchors keep non-ASCII letters", async () => {
    const { renderCatalog } = await import("../catalog/render.ts");
    const item = { name: "x", href: "/x" };
    const html = renderCatalog({
      title: "t",
      lead: "l",
      provenance: "p",
      groups: [
        { name: "Übersicht", items: [item] },
        { name: "bersicht", items: [item] },
        { name: "A\u0308nderung", items: [item] },
      ],
    });
    expect(html).toContain('id="änderung"');
    expect(html).toContain('id="übersicht"');
    expect(html).toContain('id="bersicht"');
  });
});

describe("shared prettier config", () => {
  test("an .astro file is formatted, its plugin found from the package, not the repository", () => {
    const config = join(import.meta.dirname, "..", "config", "prettier.js");
    const dir = temp();
    write(dir, {
      "package.json": JSON.stringify({ prettier: config }),
      "A.astro": '---\nconst a=1\n---\n<div   class="x">{a}</div>\n',
    });
    const prettier = join(import.meta.dirname, "..", "node_modules", ".bin", "prettier");
    const r = spawnSync(prettier, ["--check", "--ignore-unknown", "A.astro"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(`${r.stdout}${r.stderr}`).toContain("[warn] A.astro");
    expect(r.status).toBe(1);
  });
});

describe("shared stylelint config", () => {
  test("a custom property brand and the repository do not define goes red", () => {
    const config = join(import.meta.dirname, "..", "config", "stylelint.js");
    const dir = repo({
      "package.json": JSON.stringify({ name: "fx", type: "module" }),
      "node_modules/@hackersandwizards/brand/package.json": JSON.stringify({
        exports: { "./tokens.root.css": "./generated/tokens.root.css" },
      }),
      "node_modules/@hackersandwizards/brand/generated/tokens.root.css":
        ":root { --color-ink: #000; }\n",
      "src/own.css": ":root { --own-gap: 1rem; }\n",
      "stylelint.config.js": `import styles from "${config}";\nexport default styles({ importFrom: ["./src/own.css"] });\n`,
      "src/ok.css": "a { color: var(--color-ink); margin: var(--own-gap); }\n",
      "src/bad.css": "a { color: var(--color-nope); }\n",
    });
    const stylelint = join(import.meta.dirname, "..", "node_modules", ".bin", "stylelint");
    const r = spawnSync(stylelint, ["src/*.css"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(2);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain("src/bad.css");
    expect(out).toContain("--color-nope");
    expect(out).not.toContain("src/ok.css");
    // A self-closing <style> holding ">" is no CSS, and a wrapped one keeps the lines after it.
    write(dir, {
      "src/A.astro":
        '<style set:html={items.map((i) => i.css).join("")} />\n<style\n  set:html={x}\n/>\n<p>a</p>\n<style>\n  a { color: var(--color-nope); }\n</style>\n',
    });
    const astro = spawnSync(stylelint, ["src/A.astro"], { cwd: dir, encoding: "utf8" });
    expect(`${astro.stdout}${astro.stderr}`).toMatch(/src\/A\.astro\s+7:\d+/);
    expect(`${astro.stdout}${astro.stderr}`).not.toContain("Unknown word");
    write(dir, { "src/B.astro": "<style set:html={a.map((i) => i.css)} />\n<p>a</p>\n" });
    expect(spawnSync(stylelint, ["src/B.astro"], { cwd: dir, encoding: "utf8" }).status).toBe(0);
    rmSync(join(dir, "node_modules/@hackersandwizards/brand"), { recursive: true });
    const gone = spawnSync(stylelint, ["src/ok.css"], { cwd: dir, encoding: "utf8" });
    expect(gone.status).not.toBe(0);
  });

  test("a submodule's files are not linted", () => {
    const config = join(import.meta.dirname, "..", "config", "stylelint.js");
    const dir = repo({
      "package.json": JSON.stringify({ name: "fx", type: "module" }),
      "node_modules/@hackersandwizards/brand/package.json": JSON.stringify({
        exports: { "./tokens.root.css": "./tokens.root.css" },
      }),
      "node_modules/@hackersandwizards/brand/tokens.root.css": ":root { --color-ink: #000; }\n",
      "stylelint.config.js": `import styles from "${config}";\nexport default styles();\n`,
      ".gitmodules": '[submodule "sub"]\n\tpath = sub\n\turl = ../sub.git\n',
      "sub/a.css": "a { color: var(--color-nope); }\n",
      "b.css": "a { color: var(--color-nope); }\n",
    });
    const stylelint = join(import.meta.dirname, "..", "node_modules", ".bin", "stylelint");
    const r = spawnSync(stylelint, ["**/*.css"], { cwd: dir, encoding: "utf8" });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain("b.css");
    expect(out).not.toContain("sub/a.css");
  });
});

describe("check-staged", () => {
  // A stand-in for admin's bin: red while any item file says "broken".
  const adminCheck = '#!/bin/sh\n! grep -rl broken "${1:-.}/docs/agent-work/items"\n';
  const pkg = JSON.stringify({
    scaffolding: { private: true, skip: { format: "fixture", lint: "fixture" } },
    devDependencies: { "@hackersandwizards/admin": "github:acme/admin#v1.0.0" },
  });

  const lintPkg = JSON.stringify({
    scaffolding: { private: true, skip: { format: "fixture", lint: "fixture" } },
  });

  test("Markdown checks the staged blob and leaves unstaged files alone", () => {
    const dir = repo({ "package.json": lintPkg, "unrelated.md": "No title.\n" });
    write(dir, { "new.md": "No title.\n" });
    expect(sh(dir, ["add", "--", "new.md"]).status).toBe(0);
    write(dir, { "new.md": "# Working tree title\n" });
    const red = run(dir, "check-staged");
    expect(red.code).toBe(1);
    expect(red.out).toContain("new.md:1 error MD041");
    expect(red.out.trimEnd().split("\n").at(-1)).toBe(markdownRepair);
    expect(red.out).not.toContain("unrelated.md");
    expect(sh(dir, ["add", "--", "new.md"]).status).toBe(0);
    write(dir, { "new.md": "An unstaged edit.\n" });
    const green = run(dir, "check-staged");
    expect(green.code).toBe(0);
    expect(green.out).not.toContain(markdownRepair);
    expect(readFileSync(join(dir, "new.md"), "utf8")).toBe("An unstaged edit.\n");
  });

  test("ShellCheck reads the staged shebang, blob and .shellcheckrc", () => {
    const dir = repo({
      "package.json": lintPkg,
      ".shellcheckrc": "# Defaults.\n",
      "unchanged.sh": shellScript,
    });
    const env = shellcheckFixture(dir);
    write(dir, { "bin/helper": shellScript, "check-lock.ts": shellScript });
    expect(sh(dir, ["add", "--", "bin/helper", "check-lock.ts"]).status).toBe(0);
    write(dir, { "bin/helper": "#!/usr/bin/env python\n", ".shellcheckrc": "disable=SC2034\n" });
    const red = run(dir, "check-staged", [], env);
    expect(red.code).toBe(1);
    expect(red.out).toContain("In bin/helper line 2");
    expect(red.out).toContain("SC2034");
    expect(red.out.trimEnd().split("\n").at(-1)).toBe(shellRepair);
    expect(red.out).not.toMatch(/unchanged\.sh|check-lock\.ts/);
    expect(sh(dir, ["add", "--", ".shellcheckrc"]).status).toBe(0);
    write(dir, { ".shellcheckrc": "# Defaults.\n", "bin/helper": shellScript });
    const green = run(dir, "check-staged", [], env);
    expect(green.code).toBe(0);
    expect(green.out).not.toContain(shellRepair);
    expect(readFileSync(join(dir, "bin/helper"), "utf8")).toBe(shellScript);
  });

  test("ShellCheck reads an unstaged sourced sibling from the index", () => {
    const dir = repo({
      "package.json": lintPkg,
      ".shellcheckrc": "external-sources=true\n",
      "lib.sh": "#!/bin/sh\nfoo=ok\n",
    });
    const env = shellcheckFixture(dir);
    write(dir, {
      "lib.sh": "#!/bin/sh\nfalse\n",
      "a.sh": '#!/bin/sh\n. ./lib.sh\nprintf "%s\\n" "$foo"\n',
    });
    expect(sh(dir, ["add", "--", "a.sh"]).status).toBe(0);
    const result = run(dir, "check-staged", [], env);
    expect(result.code, result.out).toBe(0);
    expect(sh(dir, ["add", "--", "a.sh", "lib.sh"]).status).toBe(0);
    const red = run(dir, "check-staged", [], env);
    expect(red.code).toBe(1);
    expect(red.out).toContain("SC2154");
  });

  test("ShellCheck reports style findings in unchanged index sources", async () => {
    const dir = repo({ "package.json": lintPkg, "scripts/lib.sh": shellStyleFinding });
    const env = await realShellcheckFixture(dir);
    write(dir, {
      "scripts/main.sh": "#!/bin/sh\n. ./scripts/lib.sh\n",
      "scripts/lib.sh": "#!/bin/sh\nprintf '%s\\n' ok\n",
    });
    expect(sh(dir, ["add", "--", "scripts/main.sh"]).status).toBe(0);
    const red = run(dir, "check-staged", [], env);
    expect(red.code, red.out).toBe(1);
    expect(red.out).toMatch(/In \.\/scripts\/lib\.sh line 2:[\s\S]*SC2006 \(style\)/);
    expect(sh(dir, ["add", "--", "scripts/lib.sh"]).status).toBe(0);
    const green = run(dir, "check-staged", [], env);
    expect(green.code, green.out).toBe(0);
  });

  test("a staged item file runs admin-check, a broken one goes red", () => {
    const dir = repo({ "package.json": pkg, "docs/agent-work/items/a.md": "# Fine\n" });
    write(dir, { "node_modules/.bin/admin-check": adminCheck });
    spawnSync("chmod", ["+x", join(dir, "node_modules/.bin/admin-check")]);
    write(dir, { "docs/agent-work/items/a.md": "# broken\n" });
    sh(dir, ["add", "docs/agent-work/items/a.md"]);
    expect(run(dir, "check-staged").code).toBe(1);
    write(dir, { "docs/agent-work/items/a.md": "# Fine again\n" });
    expect(run(dir, "check-staged").code).toBe(1);
    sh(dir, ["add", "docs/agent-work/items/a.md"]);
    expect(run(dir, "check-staged").code).toBe(0);
    write(dir, { "docs/agent-work/items/a.md": "# broken, unstaged\n" });
    expect(run(dir, "check-staged").code).toBe(0);
  });

  test("check:skills reads staged paths, including deletions and both sides of renames", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        scaffolding: { private: true, skip: { format: "fixture", lint: "fixture" } },
        scripts: { "check:skills": `printf '%s' "$VALIDATE_SKILLS_PATHS" > scope.txt` },
      }),
      ".claude/gone.md": "x\n",
      ".claude/old.md": "# Rename this file\n",
    });
    write(dir, { ".claude/new.md": "# New\n", ".claude/half.md": "unstaged\n" });
    sh(dir, ["rm", "-q", ".claude/gone.md"]);
    sh(dir, ["add", ".claude/new.md"]);
    expect(sh(dir, ["config", "diff.renames", "true"]).status).toBe(0);
    expect(sh(dir, ["mv", ".claude/old.md", ".claude/renamed.md"]).status).toBe(0);
    const scope = [".claude/gone.md", ".claude/new.md", ".claude/old.md", ".claude/renamed.md"];
    const r = run(dir, "check-staged", [], { VALIDATE_SKILLS_PATHS: "elsewhere/x.md" });
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "scope.txt"), "utf8").split("\n").sort()).toEqual(scope);
    rmSync(join(dir, "scope.txt"));
    const standalone = join(import.meta.dirname, "../.claude/skills/engineering/check-staged.ts");
    const hook = spawnSync(process.execPath, ["--no-env-file", standalone], {
      cwd: dir,
      env: { ...process.env, VALIDATE_SKILLS_PATHS: "elsewhere/x.md" },
    });
    expect(hook.status).toBe(0);
    expect(readFileSync(join(dir, "scope.txt"), "utf8").split("\n").sort()).toEqual(scope);
  });

  test.each([
    { scenario: "scripts match", claude: true, change: "none", validated: "fixture" },
    { scenario: "scripts differ", claude: true, change: "script", refused: true },
    { scenario: "scripts differ outside a skill commit", claude: false, change: "script" },
    {
      scenario: "only package metadata differs",
      claude: true,
      change: "name",
      validated: "edited",
    },
  ])("check:skills when $scenario", ({ claude, change, refused, validated }) => {
    const scripts = {
      "check:skills": 'printf "%s" "$npm_package_name" > validator.txt',
      other: "true",
    };
    const pkg = {
      name: "fixture",
      scaffolding: { private: true, skip: { format: "fixture", lint: "fixture" } },
      scripts,
    };
    const dir = repo({ "package.json": JSON.stringify(pkg) });
    const staged = claude ? ".claude/changed.md" : "notes.md";
    write(dir, { [staged]: "# Staged\n" });
    expect(sh(dir, ["add", staged]).status).toBe(0);
    if (change === "script")
      write(dir, {
        "package.json": JSON.stringify({ ...pkg, scripts: { ...scripts, other: "false" } }),
      });
    if (change === "name")
      write(dir, { "package.json": JSON.stringify({ ...pkg, name: "edited" }) });

    const result = run(dir, "check-staged", [], { npm_package_name: "" });
    expect(result.code, result.out).toBe(refused ? 1 : 0);
    if (refused)
      expect(result.out.trim()).toBe(
        '[check:staged] package.json script differs between index and working tree: "other"',
      );
    const log = join(dir, "validator.txt");
    if (validated) expect(readFileSync(log, "utf8")).toBe(validated);
    else expect(existsSync(log)).toBe(false);
  });

  test.each([
    ["package hook", bin("check-staged")],
    ["standalone hook", join(import.meta.dirname, "../.claude/skills/engineering/check-staged.ts")],
  ])("%s checks a staged file moved in the working tree from the index", (_, hook) => {
    const dir = repo({
      "package.json": JSON.stringify({ scaffolding: { private: true, skip: { lint: "fixture" } } }),
      "old.md": "# Before\n",
    });
    const prettier = "node_modules/.bin/prettier";
    write(dir, {
      [prettier]: '#!/bin/sh\ncase "$*" in *--stdin-filepath*) tee checked.txt;; esac\n',
      "old.md": "# Staged\n",
    });
    chmodSync(join(dir, prettier), 0o755);
    expect(sh(dir, ["config", "diff.renames", "true"]).status).toBe(0);
    expect(sh(dir, ["add", "old.md"]).status).toBe(0);
    renameSync(join(dir, "old.md"), join(dir, "new.md"));
    expect(sh(dir, ["add", "-N", "new.md"]).status).toBe(0);
    expect(spawnSync(process.execPath, ["--no-env-file", hook], { cwd: dir }).status).toBe(0);
    expect(readFileSync(join(dir, "checked.txt"), "utf8")).toBe("# Staged\n");
  });

  test("a repository naming its validator only validate:skills is refused, not skipped", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        scaffolding: { private: true, skip: { format: "fixture", lint: "fixture" } },
        scripts: { "validate:skills": "true" },
      }),
    });
    write(dir, { ".claude/new.md": "# New\n" });
    sh(dir, ["add", ".claude/new.md"]);
    const r = run(dir, "check-staged");
    expect(r.code).toBe(1);
    expect(r.out).toContain("rename the script validate:skills to check:skills");
  });

  test("a staged name starting with a dash reaches the tool as a path", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scaffolding: { private: true, skip: { lint: "fixture" } } }),
      "node_modules/.bin/prettier": '#!/bin/sh\nprintf "%s\\n" "$@" > args.txt\n',
    });
    chmodSync(join(dir, "node_modules/.bin/prettier"), 0o755);
    write(dir, { "--no-config.ts": "export {};\n" });
    sh(dir, ["add", "--", "--no-config.ts"]);
    run(dir, "check-staged");
    expect(readFileSync(join(dir, "args.txt"), "utf8").endsWith("--\n--no-config.ts\n")).toBe(true);
  });

  test.each(["new file", "symlink replacement"])(
    "oxlint reads the staged source and layer policy after both change in the working tree (%s)",
    (entry) => {
      const config = {
        ...oxlintTemplate,
        overrides: [
          {
            files: ["src/**/*.ts"],
            rules: { "no-restricted-imports": ["error", { patterns: [{ regex: "^blocked$" }] }] },
          },
        ],
      };
      const dir = repo({
        "package.json": JSON.stringify({
          scaffolding: { private: true, skip: { format: "fixture" } },
        }),
        "eslint.config.js": "export default [];\n",
        ".oxlintrc.json": JSON.stringify(config),
      });
      install(dir);
      mkdirSync(join(dir, "node_modules/.bin"));
      symlinkSync(
        join(import.meta.dirname, "../node_modules/.bin/eslint"),
        join(dir, "node_modules/.bin/eslint"),
      );
      if (entry === "symlink replacement") {
        mkdirSync(join(dir, "src"));
        symlinkSync("../eslint.config.js", join(dir, "src/a.ts"));
        expect(sh(dir, ["add", "src/a.ts"]).status).toBe(0);
        expect(sh(dir, ["commit", "-qm", "add link", "--", "src/a.ts"]).status).toBe(0);
      }
      write(dir, { "src/replacement.ts": 'import "blocked";\n' });
      renameSync(join(dir, "src/replacement.ts"), join(dir, "src/a.ts"));
      sh(dir, ["add", "src/a.ts"]);
      write(dir, {
        "src/a.ts": "export {};\n",
        ".oxlintrc.json": JSON.stringify({ ...config, overrides: [] }),
      });
      const red = run(dir, "check-staged");
      expect(red.out).toContain("no-restricted-imports");
      expect(red.code).toBe(1);
      sh(dir, ["add", "src/a.ts"]);
      expect(run(dir, "check-staged").code).toBe(0);
    },
  );

  test("a coupling or licence step the gate skips with a reason is skipped here too", () => {
    const staged = (skip: object) => {
      const dir = repo({
        "package.json": JSON.stringify({
          scaffolding: { private: true, skip: { format: "f", lint: "f", ...skip } },
        }),
      });
      write(dir, { "a.ts": 'import x from "../../elsewhere/x.ts";\n' });
      sh(dir, ["add", "a.ts"]);
      return run(dir, "check-staged");
    };
    expect(staged({}).code).toBe(1);
    expect(staged({ coupling: "a fixture outside" }).code).toBe(0);
  });

  test("a staged item file without admin-check installed is refused", () => {
    const dir = repo({ "package.json": pkg, "docs/agent-work/items/a.md": "# Fine\n" });
    write(dir, { "docs/agent-work/items/a.md": "changed\n" });
    sh(dir, ["add", "docs/agent-work/items/a.md"]);
    const r = run(dir, "check-staged");
    expect(r.code).toBe(1);
    expect(r.out).toContain("admin-check not installed");
  });

  test("a tool that exits before reading a partly staged file fails the check, never crashes it", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        scaffolding: { private: true, skip: { lint: "fixture" } },
        devDependencies: { prettier: "3" },
      }),
      "big.txt": "a\n",
      "node_modules/.bin/prettier": "#!/bin/sh\nexit 0\n",
    });
    spawnSync("chmod", ["+x", join(dir, "node_modules/.bin/prettier")]);
    // Larger than the pipe holds, so the write outlives the tool and raises EPIPE.
    write(dir, { "big.txt": "staged line\n".repeat(200_000) });
    sh(dir, ["add", "big.txt"]);
    write(dir, { "big.txt": "unstaged\n" });
    const r = run(dir, "check-staged");
    expect(r.out).not.toContain("EPIPE");
    expect(r.out).toContain("[check:staged] prettier: big.txt as staged");
    expect(r.code).toBe(1);
  });

  test(
    "a missing prettier or eslint is refused, declared or not, unless the gate skips it",
    () => {
      const staged = (manifest: object, prettier = false) => {
        const dir = repo({ "package.json": JSON.stringify(manifest) });
        if (prettier) {
          write(dir, { "node_modules/.bin/prettier": "#!/bin/sh\nexit 0\n" });
          chmodSync(join(dir, "node_modules/.bin/prettier"), 0o755);
        }
        write(dir, { "a.ts": "export {};\n" });
        sh(dir, ["add", "a.ts"]);
        return run(dir, "check-staged");
      };
      const declared = staged({ devDependencies: { prettier: "3", eslint: "10" } });
      expect(declared.code).toBe(1);
      expect(declared.out).toContain("prettier not installed");
      const undeclared = staged({});
      expect(undeclared.code).toBe(1);
      expect(undeclared.out).toContain("prettier not installed");
      const lintMissing = staged({ scaffolding: { skip: { format: "none" } } });
      expect(lintMissing.code).toBe(1);
      expect(lintMissing.out).toContain("eslint not installed");
      expect(staged({ scaffolding: { skip: { format: "", lint: "none" } } }).out).toContain(
        "prettier not installed",
      );
      for (const format of [false, {}])
        expect(staged({ scaffolding: { skip: { format, lint: "none" } } }).out).toContain(
          "prettier not installed",
        );
      expect(staged({ scaffolding: { skip: { format: "none", lint: "none" } } }).code).toBe(0);
      const prettierOnly = staged({ scaffolding: { skip: { lint: "none" } } }, true);
      expect(prettierOnly.out).not.toContain("not installed");
      expect(prettierOnly.code).toBe(0);
    },
    limit(20_000),
  );

  test(
    "staged CSS and Astro files run stylelint with the repository's config, unless skip.styles",
    () => {
      const stylelint = join(import.meta.dirname, "..", "node_modules/stylelint/bin/stylelint.mjs");
      const html = join(import.meta.dirname, "..", "node_modules/postcss-html/lib/index.js");
      const skip = { format: "none", lint: "none" };
      const staged = (files: Record<string, string>, styles?: unknown, installed = true) => {
        const dir = repo({
          "package.json": JSON.stringify({
            type: "module",
            scaffolding: { skip: { ...skip, styles } },
          }),
          "stylelint.config.js": `export default { overrides: [{ files: ["**/*.astro"], customSyntax: "${html}" }], rules: { "color-no-invalid-hex": true } };\n`,
          "nested/.stylelintrc.json": "{}",
        });
        if (installed) {
          mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
          symlinkSync(stylelint, join(dir, "node_modules/.bin/stylelint"));
        }
        write(dir, files);
        sh(dir, ["add", ...Object.keys(files)]);
        return { dir, ...run(dir, "check-staged") };
      };
      const bad = "a { color: #ggg; }\n";
      expect(staged({ "a.css": bad }, undefined, false).out).toContain("stylelint not installed");
      expect(staged({ "a.ts": "export {};\n", ".x/a.css": bad }, undefined, false).code).toBe(0);
      expect(staged({ "a.css": bad }, "none", false).code).toBe(0);
      expect(staged({ "a.css": bad }, " ", false).out).toContain("stylelint not installed");
      // nested/c.css: a nested config would let it pass, but the repository's own governs, as in the gate.
      const red = staged({
        "a.css": bad,
        "a.ts": "#ggg\n",
        "B.astro": `<p>a</p>\n<style>\n  ${bad}</style>\n`,
        "nested/c.css": bad,
        ".storybook/d.css": bad,
      });
      expect(red.out).toContain("a.css: line 1, col 12, error - Invalid hex color");
      expect(red.out).toContain("B.astro: line 3, col 14, error - Invalid hex color");
      expect(red.out).toContain("nested/c.css: line 1, col 12");
      expect(red.out).not.toContain("a.ts:");
      expect(red.out).not.toContain("d.css");
      expect(red.code).toBe(1);
      const ok = staged({ "a.css": "a { color: #fff; }\n" });
      expect(ok.code).toBe(0);
      write(ok.dir, { "a.css": bad });
      sh(ok.dir, ["add", "a.css"]);
      write(ok.dir, { "a.css": "a { color: #000; }\n" });
      const partial = run(ok.dir, "check-staged");
      expect(partial.out).toContain("[check:staged] stylelint: a.css as staged");
      expect(partial.code).toBe(1);
    },
    limit(20_000),
  );

  test("the index decides: its package.json, no submodule as a file, the item copy in the checkout", () => {
    const tools = {
      // prettier logs the paths it gets and fails a.ts; admin-check logs the folder it gets.
      "node_modules/.bin/prettier":
        '#!/bin/sh\necho "$@" >> args.log\ncase "$*" in *a.ts*) exit 1;; esac\n',
      "node_modules/.bin/admin-check": '#!/bin/sh\necho "$1" >> items.log\n',
    };
    const manifest = (skip: object) =>
      JSON.stringify({
        scaffolding: { private: true, skip: { lint: "fixture", ...skip } },
        devDependencies: { "@hackersandwizards/admin": "1.0.0" },
      });
    const dir = repo({ "package.json": manifest({}), ...tools });
    for (const tool of Object.keys(tools)) chmodSync(join(dir, tool), 0o755);
    const commit = (skip: object) => {
      write(dir, { "package.json": manifest(skip) });
      sh(dir, ["commit", "-qm", "manifest", "package.json"]);
    };
    write(dir, { "a.ts": "x\n" });
    sh(dir, ["add", "a.ts"]);
    // An unstaged skip leaves the tool on; an unstaged removal leaves the staged skip in force.
    write(dir, { "package.json": manifest({ format: "unstaged" }) });
    expect(run(dir, "check-staged").code).toBe(1);
    commit({ format: "committed" });
    write(dir, { "package.json": manifest({}) });
    expect(run(dir, "check-staged").code).toBe(0);
    commit({});
    sh(dir, ["rm", "-q", "--cached", "a.ts"]);
    // A submodule's new commit, with the submodule dirty, is no file for prettier.
    const sub = repo({ "x.md": "x\n" });
    sh(dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"]);
    sh(dir, ["commit", "-qm", "sub"]);
    sh(join(dir, "sub"), ["commit", "-q", "--allow-empty", "-m", "next"]);
    write(dir, { "sub/x.md": "dirty\n", "docs/agent-work/items/a.md": "# A\n" });
    sh(dir, ["add", "sub", "docs/agent-work/items/a.md"]);
    const r = run(dir, "check-staged");
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "args.log"), "utf8")).not.toMatch(/\bsub\b/);
    expect(
      readFileSync(join(dir, "items.log"), "utf8").startsWith(
        `${realpathSync(dir)}/node_modules/.cache/scaffolding/staged-items-`,
      ),
    ).toBe(true);
  });

  test("a file staged in the old docs/tracking folder runs admin-check too", () => {
    const dir = repo({ "package.json": pkg });
    write(dir, { "docs/tracking/items/a.md": "fine\n" });
    sh(dir, ["add", "docs/tracking/items/a.md"]);
    expect(run(dir, "check-staged").out).toContain("admin-check not installed");
  });
});

describe("raise-pins", () => {
  // Local stand-ins for company packages under an owner folder, as on GitHub: b depends on a, and
  // each has tags v1.0.0 to v1.10.0.
  function packages(
    names = ["a", "b"],
    scope = "@hackersandwizards/",
    owner = "hackersandwizards",
  ) {
    const base = join(temp(), owner);
    mkdirSync(base);
    for (const name of names) {
      const dir = join(base, name);
      mkdirSync(dir);
      sh(dir, ["init", "-q", "-b", "main"]);
      for (const version of ["1.0.0", "1.2.0", "1.10.0"]) {
        const deps = name === "b" ? { "@hackersandwizards/a": `git+file://${base}/a#v1.0.0` } : {};
        write(dir, {
          "package.json": JSON.stringify({
            name: `${scope}${name}`,
            version,
            dependencies: deps,
          }),
        });
        sh(dir, ["add", "-A"]);
        sh(dir, ["commit", "-qm", version]);
        sh(dir, ["tag", `v${version}`]);
      }
    }
    return base;
  }
  function consumer(
    base: string,
    scripts: Record<string, string>,
    names = ["b", "a"],
    others: Record<string, string> = {},
  ) {
    const dependencies = Object.fromEntries(
      names.map((name) => [`@hackersandwizards/${name}`, `git+file://${base}/${name}#v1.0.0`]),
    );
    Object.assign(dependencies, others);
    const pkg = { name: "c", private: true, scripts, dependencies };
    const dir = repo({ "package.json": `${JSON.stringify(pkg, null, 2)}\n` }, false);
    const env = { ...process.env, BUN_INSTALL_CACHE_DIR: cacheDir };
    expect(spawnSync("bun", ["install"], { cwd: dir, env }).status).toBe(0);
    sh(dir, ["add", "-A"]);
    sh(dir, ["commit", "-qm", "init"]);
    return dir;
  }
  const version = (dir: string, name: string) =>
    jsonObject(readFileSync(join(dir, "node_modules/@hackersandwizards", name, "package.json")))
      .version;
  // Fixture clones get new commits every run: a cache of their own keeps them out of the user's.
  const cacheDir = temp();
  const identity = {
    BUN_INSTALL_CACHE_DIR: cacheDir,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };

  test("raises each pin to the newest tag in dependency order, gates, and commits only with --commit", () => {
    const base = packages();
    const dir = consumer(base, { check: "true" });
    const r = run(dir, "raise-pins", [], identity);
    expect(r.code).toBe(0);
    expect(lines(r.out, "raise-pins")).toEqual([
      "[raise-pins] @hackersandwizards/a: v1.0.0 -> v1.10.0",
      "[raise-pins] @hackersandwizards/b: v1.0.0 -> v1.10.0",
      "[raise-pins] gate green with a v1.10.0, b v1.10.0",
    ]);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toContain(`${base}/a#v1.10.0"`);
    expect(version(dir, "a")).toBe("1.10.0");
    expect(sh(dir, ["rev-list", "--count", "HEAD"]).stdout.toString().trim()).toBe("1");

    sh(dir, ["checkout", "--", "package.json", "bun.lock"]);
    const committed = run(dir, "raise-pins", ["--commit"], identity);
    expect(committed.code).toBe(0);
    expect(sh(dir, ["log", "-1", "--format=%s"]).stdout.toString().trim()).toBe(
      "pins: raise a v1.10.0, b v1.10.0",
    );
    expect(sh(dir, ["status", "--porcelain"]).stdout.toString()).toBe("");
    const again = run(dir, "raise-pins", ["--commit"], identity);
    expect(lines(again.out, "raise-pins")).toContain(
      "[raise-pins] nothing raised, so the gate did not run",
    );
  });

  test("selects a pin by its repository's owner, not its name: an unscoped one of ours rises, a foreign one stays", () => {
    const ours = packages(["u"], "");
    const foreign = packages(["f"], "", "someone");
    const dir = consumer(ours, { check: "true" }, [], {
      u: `git+file://${ours}/u#v1.0.0`,
      f: `git+file://${foreign}/f#v1.0.0`,
    });
    const r = run(dir, "raise-pins", ["--commit"], identity);
    expect(r.code).toBe(0);
    expect(lines(r.out, "raise-pins")).toEqual([
      "[raise-pins] u: v1.0.0 -> v1.10.0",
      "[raise-pins] gate green with u v1.10.0",
      '[raise-pins] committed "pins: raise u v1.10.0"',
    ]);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toContain(`${foreign}/f#v1.0.0"`);
  });

  test("a remote not read keeps its pin and leaves the other raises to commit", () => {
    const base = packages();
    const dir = consumer(base, { check: "true" });
    renameSync(join(base, "b"), join(base, "b-gone"));
    const r = run(dir, "raise-pins", ["--commit"], identity);
    expect(r.code).toBe(1);
    expect(r.out).toContain("[raise-pins] @hackersandwizards/b: no v<version> tag read from");
    expect(sh(dir, ["log", "-1", "--format=%s"]).stdout.toString().trim()).toBe(
      "pins: raise a v1.10.0",
    );
  });

  test("a tag read over SSH that never answers ends within SCAFFOLDING_FETCH_WAIT_S, ssh with it", async () => {
    const dir = temp();
    const hang = join(dir, "ssh");
    writeFileSync(hang, `#!/bin/sh\necho $$ > ${dir}/pid\nexec sleep 30\n`, { mode: 0o755 });
    const env = { ...process.env };
    Object.assign(process.env, { GIT_SSH_COMMAND: hang, SCAFFOLDING_FETCH_WAIT_S: "1" });
    try {
      const started = Date.now();
      expect(await newestTag("ssh://git@github.com/acme/none.git")).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      process.env = env;
    }
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("invalid and capped fetch timeouts still give Git time to read local tags", async () => {
    const remote = join(packages(["a"]), "a");
    const saved = { ...process.env };
    try {
      for (const wait of ["-1", "1e10", "99999999999"]) {
        process.env.SCAFFOLDING_FETCH_WAIT_S = wait;
        expect(await newestTag(remote)).toBe("v1.10.0");
      }
    } finally {
      process.env = saved;
    }
  });

  test("a scaffolding raise commits what check-structure --fix wrote, unless --fix rewrote an edit", () => {
    const base = packages(["scaffolding"]);
    const fix = { check: "true", "check-structure": "echo fixed > skeleton.txt" };
    const dir = consumer(base, fix, ["scaffolding"]);
    // git status lists an untracked nested repository as a directory.
    sh(dir, ["init", "-q", "nested"]);
    expect(run(dir, "raise-pins", ["--commit"], identity).code).toBe(0);
    expect(sh(dir, ["show", "--name-only", "--format=", "HEAD"]).stdout.toString()).toContain(
      "skeleton.txt",
    );

    const edited = consumer(base, { ...fix, "check-structure": "echo fixed > edited.txt" }, [
      "scaffolding",
    ]);
    write(edited, { "edited.txt": "committed\n" });
    sh(edited, ["add", "edited.txt"]);
    sh(edited, ["commit", "-qm", "edited"]);
    write(edited, { "edited.txt": "someone's edit\n" });
    const r = run(edited, "raise-pins", ["--commit"], identity);
    expect(r.code).toBe(1);
    expect(r.out).toContain("check-structure --fix rewrote edited.txt");
    expect(sh(edited, ["log", "-1", "--format=%s"]).stdout.toString().trim()).toBe("edited");
  });

  test("a commit its hook refuses leaves nothing staged and says so", () => {
    const dir = consumer(packages(["a"]), { check: "true" }, ["a"]);
    write(dir, { "hooks/pre-commit": "#!/bin/sh\nexit 1\n" });
    chmodSync(join(dir, "hooks/pre-commit"), 0o755);
    sh(dir, ["config", "core.hooksPath", "hooks"]);
    const r = run(dir, "raise-pins", ["--commit"], identity);
    expect(r.code).toBe(1);
    expect(r.out).toContain("[raise-pins] the commit failed (above)");
    expect(sh(dir, ["diff", "--cached", "--name-only"]).stdout.toString()).toBe("");
  });

  test("a red gate commits nothing; an uncommitted package.json stops it before any change", () => {
    const dir = consumer(packages(), { check: "exit 1" }, ["a"]);
    const r = run(dir, "raise-pins", ["--commit"], identity);
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "[raise-pins] nothing committed: package.json and bun.lock keep the raise",
    );
    expect(sh(dir, ["rev-list", "--count", "HEAD"]).stdout.toString().trim()).toBe("1");
    const dirty = run(dir, "raise-pins", [], identity);
    expect(dirty.code).toBe(1);
    expect(dirty.out).toContain("uncommitted change");
  });
});

describe("check-spaces", () => {
  const page = [
    "---",
    "const a = 1",
    "<code>in frontmatter</code>",
    "---",
    "<p>",
    "  drawn by",
    "  <code>brand</code>'s <code>elements.css</code> at the dense scale.",
    "  <code>x</code> in",
    "  <strong>check</strong>",
    "  holds each, and",
    '  <a href="/x">a link</a>.',
    '  Wanted{" "}',
    "  <em>space</em>",
    "  {list.map((i) => (",
    "    <span>{i}</span>",
    "  ))}",
    "  {cond && (",
    "    <span>y</span>",
    "  )}",
    "  <!-- a comment",
    "  <kbd>k</kbd> -->",
    "  (",
    "  <code>z</code>",
    "</p>",
    "<script>",
    "  const s = 1",
    "  <span>",
    "</script>",
    '<script type="application/ld+json" set:html={JSON.stringify(x => y)} />',
    "<p>",
    "  then",
    "  <a",
    '    href="/x">x</a>',
    "</p>",
    "<pre-view>",
    "  drawn by",
    "  <code>x</code>",
    "</pre-view>",
    "<pre>",
    "run the",
    "<code>check</code>",
    "</pre>",
    "<p>",
    "  sold by",
    "  <small>x</small>",
    "</p>",
    "",
  ].join("\n");

  test("finds text meeting an inline tag across a line break, and nothing else", () => {
    const r = run(repo({ "src/A.astro": page, "package.json": "{}" }), "check-spaces");
    expect(r.code).toBe(1);
    expect(
      lines(r.out, "spaces").map((l) => l.match(/line (\d+):.*?meets <(\w+)>/)!.slice(1)),
    ).toEqual([
      ["6", "code"],
      ["7", "code"],
      ["8", "strong"],
      ["9", "strong"],
      ["10", "a"],
      ["31", "a"],
      ["36", "code"],
      ["44", "small"],
    ]);
    const empty = run(
      repo({ "src/B.astro": "---\n---\n<code>x</code>\n", "package.json": "{}" }),
      "check-spaces",
    );
    expect(empty.code).toBe(0);
  });

  test("a closing tag broken before its >, an expression before a tag and punctuation after one", () => {
    const flagged = (body: string) =>
      lines(
        run(repo({ "src/A.astro": `<p>\n${body}\n</p>\n`, "package.json": "{}" }), "check-spaces")
          .out,
        "spaces",
      ).length;
    for (const body of [
      "  <a>x</a\n  >\n  word",
      "  by {name}\n  <a>x</a>",
      "  <a>x</a>\n  {name}",
      "  <a>x</a>\n  (see)",
      '  <a>x</a>\n  "quoted"',
      "  <a>x</a>\n  - dash",
      "  by\n  <img/>",
      "  {count} items by {name}\n  <a>x</a>",
      "  <a>x</a>\n  [see]",
      '  <a>x</a>\n  {cond ? "a" : "b"} more',
      "  <a>x</a>\n  {name}.",
      "  <a>x</a>\n  {name} <em>y</em>",
      '  <a>x</a>\n  {name} <em\n    class="y">z</em>',
    ])
      expect([body, flagged(body)]).toEqual([body, 1]);
    for (const body of [
      '  by {name}{" "}\n  <a>x</a>',
      `  by {name}{' '}\n  <a>x</a>`,
      '  <a>x</a>\n  {" "}\n  word',
      '  <a>x</a\n  >{" "}\n  word',
      "  <a\n    href={x}\n  >x</a>",
      "  {items\n    .filter((i) => i)\n    .map((i) => <b>{i}</b>)}\n  <a>x</a>",
      "  {name}\n  <a>x</a>",
      "  {cond && (\n    <b>y</b>\n  )}\n  <a>x</a>",
      "  {cond && <b t={{ a: 1 }}>y</b>}\n  <a>x</a>",
      "  <a>x</a>\n  {cond && <b>y</b>}",
      "  <a>x</a>\n  {list.map((i) => (\n    <b>{i}</b>\n  ))}",
      "  <a>x</a>\n  {items.map(({ name }) => (\n    <b>{name}</b>\n  ))}",
      "  <a>x</a>\n  {Object.entries({ a: 1 }).map(([k, v]) => (\n    <b>{k}</b>\n  ))}",
    ])
      expect([body, flagged(body)]).toEqual([body, 0]);
  });

  test("passes where every Astro config sets compressHTML to true or false; the default jsx, or a commented setting, reads", () => {
    const off = "export default {\n  compressHTML: false,\n};\n";
    const code = (configs: Record<string, string>) =>
      run(repo({ "src/A.astro": page, "package.json": "{}", ...configs }), "check-spaces").code;
    expect(code({ "astro.config.mjs": off, "catalog/astro.config.ts": off })).toBe(0);
    expect(
      code({
        "astro.config.mjs": off,
        "catalog/astro.config.ts": "export default { compressHTML: true };\n",
      }),
    ).toBe(0);
    expect(code({ "astro.config.mjs": 'export default { compressHTML: "jsx" };\n' })).toBe(1);
    expect(
      code({ "astro.config.mjs": off, "catalog/astro.config.ts": "export default {};\n" }),
    ).toBe(1);
    expect(code({ "astro.config.mts": "// compressHTML: false\nexport default {};\n" })).toBe(1);
  });

  test("reads the components a package ships whatever its own compressHTML, as consumers compile them at jsx", () => {
    const off = { "astro.config.mjs": "export default { compressHTML: false };\n" };
    const flagged = (
      pkg: object,
      body = "  <span>label</span>\n  {text}",
      configs: Record<string, string> = off,
    ) =>
      lines(
        run(
          repo({
            ...configs,
            "components/A.astro": `---\nimport B from "../lib/B.astro";\n---\n<p>\n${body}\n</p>\n`,
            "lib/B.astro": `<p>\n${body}\n</p>\n`,
            "src/C.astro": `<p>\n${body}\n</p>\n`,
            "package.json": JSON.stringify({ name: "fx", version: "1.0.0", ...pkg }),
          }),
          "check-spaces",
        ).out,
        "spaces",
      ).map((l) => l.match(/\] ([^:]+):/)![1]);
    // What ships is what bun pm pack lists, which a package declaring none of files, exports or
    // bin keeps from consumers; with exports, what an exported path names and that imports.
    expect(flagged({})).toEqual([]);
    expect(flagged({ files: ["components", "README.md"] })).toEqual(["components/A.astro"]);
    expect(flagged({ exports: { "./A": { default: "./components/A.astro" } } })).toEqual([
      "components/A.astro",
      "lib/B.astro",
    ]);
    expect(flagged({ exports: { "./parts/*": "./components/*" } })).toEqual([
      "components/A.astro",
      "lib/B.astro",
    ]);
    expect(flagged({ exports: { "./x": "./x.ts" } })).toEqual([]);
    // There a line holding one expression whose first element is inline counts after a closing
    // tag or text too: the package's pages show the space; at jsx its own pages show it gone.
    const files = { files: ["components"] };
    for (const body of [
      "  <a>x</a>\n  {cond && <b>y</b>}",
      '  <span>{chapter.title}</span>\n  {toc[i] > 0 && <span class="page">{toc[i]}</span>}',
      "  <a>x</a>\n  {cond && <b t={{ a: 1 }}>y</b>}",
      "  contents\n  {n > 0 && <span>{n}</span>}",
    ]) {
      expect([body, flagged(files, body)]).toEqual([body, ["components/A.astro"]]);
      expect([body, flagged(files, body, {})]).toEqual([body, []]);
    }
    for (const body of [
      "  <a>x</a>\n  {cond && <div>y</div>}",
      "  <a>x</a>\n  {cond && <div><span>y</span></div>}",
      "  <a>x</a>\n  {cond && (\n    <b>y</b>\n  )}",
      "  {cond && <b>y</b>}\n  <a>x</a>",
    ])
      expect([body, flagged(files, body)]).toEqual([body, []]);
  });

  test("an allow entry keeps a flex case; a stale one is red", () => {
    const allowed = (text: string) =>
      repo({
        "src/A.astro": "<h2>\n  <span></span>\n  Running\n</h2>\n",
        "package.json": JSON.stringify({
          scaffolding: { allow: [{ check: "spaces", path: "src/*.astro", text, reason: "flex" }] },
        }),
      });
    expect(run(allowed("<span></span>"), "check-spaces").code).toBe(0);
    expect(run(allowed("nothing"), "check-spaces").out).toContain("allow entry matches nothing");
  });
});

describe("check-cycles", () => {
  const cycle = (files: Record<string, string>) => run(repo(files), "check-cycles");
  const page = "src/pages/index.astro";
  const frontmatter = (specifier: string) =>
    `---\nimport { value } from "${specifier}";\n---\n<p>{value}</p>\n`;

  test("a runtime cycle through Astro frontmatter names the original paths once", () => {
    const r = cycle({
      [page]: frontmatter("./value.ts"),
      "src/pages/value.ts": 'import Page from "./index.astro";\nexport const value = Page;\n',
    });
    expect(r.code).toBe(1);
    expect(lines(r.out, "cycles")).toHaveLength(1);
    expect(r.out).toContain(`${page} -> src/pages/value.ts -> ${page}`);
    expect(r.out).not.toMatch(/\.astro\.ts|node_modules\/\.cache/);
  });

  test("client script imports stay separate from frontmatter imports", () => {
    const files = {
      [page]: '<p>Page</p>\n<script>import "./value.ts";</script>\n',
      "src/pages/value.ts": 'import Page from "./index.astro";\nexport const value = Page;\n',
    };
    expect(cycle(files)).toEqual({ code: 0, out: "" });
    expect(cycle({ ...files, [page]: frontmatter("./value.ts") }).code).toBe(1);
  });

  test("a style block creates no self-cycle and a real self-import still fails", () => {
    const style = "<style>p { color: red; }</style>\n";
    expect(cycle({ [page]: `<p>Page</p>\n${style}` })).toEqual({ code: 0, out: "" });
    const r = cycle({ [page]: `---\nimport Page from "./index.astro";\n---\n<Page />\n${style}` });
    expect(r.code).toBe(1);
    expect(lines(r.out, "cycles")).toHaveLength(1);
    expect(r.out).toContain(`${page} -> ${page}`);
  });

  test("an Astro cycle follows tsconfig paths across local and installed config files", () => {
    const dir = repo({
      "tsconfig.json": '{"extends":"./config/tsconfig.paths.json"}',
      "config/tsconfig.paths.json":
        '{"extends":"cycle-config/tsconfig.json","compilerOptions":{"baseUrl":"..","paths":{"@/*":["src/*"]}}}',
      [page]: frontmatter("@/pages/value"),
      "src/pages/value.ts": 'import Page from "@/pages/index.astro";\nexport const value = Page;\n',
    });
    write(dir, {
      "node_modules/cycle-config/tsconfig.json": '{"compilerOptions":{"strict":true}}',
    });
    const r = run(dir, "check-cycles");
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${page} -> src/pages/value.ts -> ${page}`);
  });

  test("the mirror requires tracked Astro and both paths catch TypeScript cycles", () => {
    const dir = repo({ "a.ts": 'import "./b.ts";\n', "b.ts": 'import "./a.ts";\n' });
    const mirrorCache = join(dir, "node_modules", ".cache", "scaffolding");
    const plain = run(dir, "check-cycles");
    expect(plain.code).toBe(1);
    expect(plain.out).toContain("a.ts -> b.ts -> a.ts");
    expect(existsSync(mirrorCache)).toBe(false);

    write(dir, { [page]: "<p>Page</p>\n" });
    expect(run(dir, "check-cycles").out).toContain("a.ts -> b.ts -> a.ts");
    expect(existsSync(mirrorCache)).toBe(false);
    expect(sh(dir, ["add", "--", page]).status).toBe(0);
    const astro = run(dir, "check-cycles");
    expect(astro.code).toBe(1);
    expect(astro.out).toContain("a.ts -> b.ts -> a.ts");
    expect(readdirSync(mirrorCache)).toEqual([]);
  });

  test("an Astro compiler error names the source and the mirror is removed", () => {
    const dir = repo({ [page]: "---\nconst =\n---\n<p>Page</p>\n" });
    const r = run(dir, "check-cycles");
    expect(r.code).toBe(1);
    expect(r.out).toContain(`[cycles] ${page}:`);
    expect(r.out).toContain("Unexpected token");
    expect(readdirSync(join(dir, "node_modules", ".cache", "scaffolding"))).toEqual([]);
  });

  test("a tracked file colliding with an Astro module is reported against the component", () => {
    const r = cycle({ [page]: "<p>Page</p>\n", [`${page}.ts`]: "export {};\n" });
    expect(r.code).toBe(1);
    expect(lines(r.out, "cycles")).toEqual([
      `[cycles] ${page}: a tracked file collides with the compiled module name`,
    ]);
  });

  test("a missing Astro compiler fails only when Astro files need it", () => {
    const installation = temp();
    const entry = join(installation, "bin", "check-cycles.ts");
    mkdirSync(dirname(entry));
    copyFileSync(bin("check-cycles"), entry);
    symlinkSync(join(import.meta.dirname, "..", "lib"), join(installation, "lib"), "dir");
    const modules = join(installation, "node_modules");
    mkdirSync(modules);
    symlinkSync(
      join(import.meta.dirname, "..", "node_modules", "dependency-cruiser"),
      join(modules, "dependency-cruiser"),
      "dir",
    );

    const dir = repo({ "a.ts": "export const a = 1;\n" });
    const check = () =>
      spawnSync(process.execPath, ["--no-install", "--no-env-file", entry], {
        cwd: dir,
        encoding: "utf8",
      });
    expect(check().status).toBe(0);
    write(dir, { [page]: "<p>Page</p>\n" });
    expect(sh(dir, ["add", "--", page]).status).toBe(0);
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[cycles] package.json: cannot load @astrojs/compiler-rs");
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });

  test("the Astro mirror cannot write through a cache symlink outside the checkout", () => {
    const dir = repo({ [page]: "<p>Page</p>\n" });
    const outside = temp();
    symlinkSync(outside, join(dir, "node_modules"), "dir");
    const r = run(dir, "check-cycles");
    expect(r.code).toBe(1);
    expect(r.out).toContain("the cycles cache path contains a symlink");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a runtime import cycle goes red once, naming its modules", () => {
    const r = cycle({
      "src/a.ts": 'import { b } from "./b.ts";\nexport const a = (): number => b() + 1;\n',
      "src/b.ts": 'import { a } from "./a.ts";\nexport const b = (): number => a() + 1;\n',
      "src/c.ts": 'import { a } from "./a.ts";\nexport const c = a();\n',
    });
    expect(r.code).toBe(1);
    expect(lines(r.out, "cycles")).toHaveLength(1);
    expect(r.out).toContain("src/a.ts -> src/b.ts -> src/a.ts");
  });

  test("a cycle of type-only imports passes, with the keyword or without", () => {
    const r = cycle({
      "src/a.ts":
        'import type { B } from "./b.ts";\nimport { C } from "./c.ts";\nexport type A = { b?: B; c?: C };\n',
      "src/b.ts": 'import type { A } from "./a.ts";\nexport type B = { a?: A };\n',
      "src/c.ts": 'import { A } from "./a.ts";\nexport type C = { a?: A };\n',
    });
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  });

  test("a cycle through a tsconfig path alias goes red", () => {
    const r = cycle({
      "tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n',
      "src/a.ts": 'import { b } from "@/b";\nexport const a = (): number => b() + 1;\n',
      "src/b.ts": 'import { a } from "@/a";\nexport const b = (): number => a() + 1;\n',
    });
    expect(r.code).toBe(1);
    expect(lines(r.out, "cycles")).toHaveLength(1);
  });

  describe.each(["src/pages/index.ts", page])("import checks in %s", (source) => {
    const astro = source.endsWith(".astro");
    const sourceWithImports = (imports: string) =>
      astro ? `---\n${imports}\n---\n<p>Page</p>\n` : `${imports}\n`;

    test("reports a sibling import by relative path and by alias", () => {
      const parent = temp();
      const dir = repo({
        "tsconfig.json": '{"compilerOptions":{"paths":{"@sibling/*":["../sibling/*"]}}}',
        [source]: sourceWithImports('import "./inside.ts";\nimport "installed-package";'),
        "src/pages/inside.ts": "export const value = 1;\n",
      });
      write(parent, {
        "sibling/value.ts": 'import "./loop.ts";\nexport const value = 2;\n',
        "sibling/loop.ts": 'import "./value.ts";\n',
        "node_modules/installed-package/index.js": 'import "./missing.js";\n',
      });
      const checkout = join(parent, "checkout");
      renameSync(dir, checkout);
      expect(run(checkout, "check-cycles")).toEqual({ code: 0, out: "" });

      for (const specifier of ["../../../sibling/value.ts", "@sibling/value"]) {
        write(checkout, { [source]: sourceWithImports(`import "${specifier}";`) });
        const r = run(checkout, "check-cycles");
        expect(r.code).toBe(1);
        expect(lines(r.out, "cycles")).toEqual([
          `[cycles] ${source}: import leaves the checkout: take another repository's code from its published package, never from a sibling path (${specifier} -> ../sibling/value.ts)`,
        ]);
      }
    });

    test("checks relative files on disk and lets unresolved packages and aliases pass", () => {
      const imports = [
        'import "./style.css";',
        'import "./icon.svg?raw";',
        'import "./data.json";',
        'import "unresolvable-package/entry";',
        'import "@/unresolvable-alias";',
        ...(astro ? ['import "./component.astro";'] : []),
      ].join("\n");
      const dir = repo({
        ".gitignore": "node_modules\n/src/pages/*.css\n/src/pages/*.svg\n/src/pages/*.json\n",
        [source]: sourceWithImports(imports),
        ...(astro ? { "src/pages/component.astro": "<p>Component</p>\n" } : {}),
      });
      write(dir, {
        "src/pages/style.css": "p { color: red; }\n",
        "src/pages/icon.svg": "<svg/>\n",
        "src/pages/data.json": "{}\n",
      });
      expect(run(dir, "check-cycles")).toEqual({ code: 0, out: "" });

      rmSync(join(dir, "src/pages/icon.svg"));
      write(dir, { [source]: sourceWithImports(`${imports}\nimport "../missing.ts";`) });
      const r = run(dir, "check-cycles");
      expect(r.code).toBe(1);
      expect(lines(r.out, "cycles")).toEqual([
        `[cycles] ${source}: relative import does not resolve to a file (../missing.ts)`,
        `[cycles] ${source}: relative import does not resolve to a file (./icon.svg?raw)`,
      ]);
    });
  });

  test("a submodule's cycle is its own repository's, and a repository without code passes", () => {
    const loop = {
      "a.ts": 'import { b } from "./b.ts";\nexport const a = (): number => b();\n',
      "b.ts": 'import { a } from "./a.ts";\nexport const b = (): number => a();\n',
    };
    const dir = repo({ "README.md": "x\n" });
    expect(run(dir, "check-cycles").code).toBe(0);
    sh(dir, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      repo(loop),
      "vendor/in",
    ]);
    expect(run(dir, "check-cycles").code).toBe(0);
    // Control: the same files in the repository itself.
    expect(cycle(loop).code).toBe(1);
  });
});

describe("check-licenses", () => {
  function installed(licences: Record<string, unknown>, scaffolding: object = {}) {
    const files: Record<string, string> = {};
    const dependencies: Record<string, string> = {};
    for (const [name, licence] of Object.entries(licences)) {
      const folder = name.replace("/", "+");
      files[`pkgs/${folder}/package.json`] = JSON.stringify({
        name,
        version: "1.0.0",
        ...(licence === undefined ? {} : (licence as object)),
      });
      dependencies[name] = `file:./pkgs/${folder}`;
    }
    const dir = repo({
      ...files,
      "package.json": JSON.stringify({ name: "fx", dependencies, scaffolding }),
    });
    const install = spawnSync(process.execPath, ["install"], { cwd: dir, encoding: "utf8" });
    expect(install.status).toBe(0);
    return dir;
  }
  const license = (l: string) => ({ license: l });

  test("the report's edge cases: copyleft and unknown red, permissive and OR green, own skipped", () => {
    const dir = installed({
      "gpl-3-only": license("GPL-3.0-only"),
      "agpl-3": license("AGPL-3.0"),
      "@scope/agpl-later": license("AGPL-3.0-or-later"),
      "gpl-2-plus": license("GPL-2.0+"),
      "bare-lgpl": license("LGPL"),
      "and-lgpl": license("Apache-2.0 AND LGPL-3.0-or-later"),
      "gpl-with": license("GPL-2.0-only WITH Classpath-exception-2.0"),
      "or-gpl": license("(MIT OR GPL-3.0-or-later)"),
      "array-mit-gpl": { licenses: [{ type: "MIT" }, { type: "GPL-2.0" }] },
      "mpl-2": license("MPL-2.0"),
      "nested-or": license("(MIT AND (LGPL-2.1-or-later OR BSD-3-Clause))"),
      "no-field": undefined,
      "see-license": license("SEE LICENSE IN LICENSE"),
      "vendor-url": license("https://example.com/terms"),
      "@hackersandwizards/own": license("SEE LICENSE IN LICENSE"),
      "@img/sharp-libvips-darwin-arm64": license("LGPL-3.0-or-later"),
    });
    const r = run(dir, "check-licenses");
    expect(r.code).toBe(1);
    const red = lines(r.out, "check-licenses").map((l) => l.match(/^\S+ @?[^@]+/)?.[0]);
    expect(red.sort()).toEqual(
      [
        "@scope/agpl-later",
        "agpl-3",
        "and-lgpl",
        "bare-lgpl",
        "gpl-2-plus",
        "gpl-3-only",
        "gpl-with",
        "no-field",
        "see-license",
        "vendor-url",
      ].map((n) => `[check-licenses] ${n}`),
    );
    expect(r.out).toContain("bun pm why gpl-3-only");
    expect(r.out).toContain('"gpl-3-only": { "license": "GPL-3.0-only"');
  });

  test("a planted GPL dependency is red, a permissive one green", () => {
    expect(run(installed({ planted: license("GPL-3.0-only") }), "check-licenses").code).toBe(1);
    expect(run(installed({ planted: license("MIT") }), "check-licenses").code).toBe(0);
  });

  test(
    "an exception pins the licence string and needs a reason; a stale one is red",
    () => {
      const keep = (licenses: object) =>
        run(
          installed({ gsap: license("Standard 'no charge' license") }, { licenses }),
          "check-licenses",
        );
      const pinned = { license: "Standard 'no charge' license", reason: "dev only" };
      expect(keep({ gsap: pinned }).code).toBe(0);
      expect(keep({ "gs*": pinned }).code).toBe(0);
      const changed = keep({ gsap: { ...pinned, license: "MIT" } });
      expect(changed.code).toBe(1);
      expect(changed.out).toContain('pins "MIT", installed is "Standard');
      for (const gsap of [
        { license: pinned.license },
        { ...pinned, reason: {} },
        { ...pinned, license: true },
      ]) {
        const reasonless = keep({ gsap });
        expect(reasonless.code).toBe(1);
        expect(reasonless.out).toContain("needs a license string and a reason");
      }
      const stale = keep({ gsap: pinned, "left-pad": { license: "MIT", reason: "gone" } });
      expect(stale.code).toBe(1);
      expect(stale.out).toContain('scaffolding.licenses["left-pad"] matches no installed package');
    },
    limit(20_000),
  );

  test("fails closed: no node_modules, an empty one, a missing lockfile", () => {
    const dir = installed({ fine: license("MIT") });
    renameSync(join(dir, "node_modules"), join(dir, "node_modules-away"));
    const missing = run(dir, "check-licenses");
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("run bun install");
    mkdirSync(join(dir, "node_modules"));
    const empty = run(dir, "check-licenses");
    expect(empty.code).toBe(1);
    expect(empty.out).toContain("run bun install");
    const bare = repo({ "package.json": JSON.stringify({ name: "fx" }) });
    expect(run(bare, "check-licenses").code).toBe(1);
  });

  test("a lock entry bun skips passes when nothing installed needs it, and is red when it is", () => {
    // Tailwind's oxide-wasm32-wasi shape: "a" bundles its own "b", and the top-level "b" serves
    // only "c", which this platform leaves out.
    const mit = { version: "1.0.0", license: "MIT" };
    const dir = repo({
      "src/a/package.json": JSON.stringify({
        name: "a",
        ...mit,
        dependencies: { b: "1.0.0" },
        bundledDependencies: ["b"],
      }),
      "src/a/node_modules/b/package.json": JSON.stringify({ name: "b", ...mit }),
      "src/b/package.json": JSON.stringify({ name: "b", ...mit }),
      "src/c/package.json": JSON.stringify({ name: "c", ...mit, dependencies: { b: "1.0.0" } }),
      "package.json": JSON.stringify({
        name: "fx",
        dependencies: { a: "file:./a-1.0.0.tgz" },
        optionalDependencies: { c: "file:./c-1.0.0.tgz" },
        overrides: { b: "file:./b-1.0.0.tgz" },
      }),
    });
    for (const p of ["a", "b", "c"])
      spawnSync(process.execPath, ["pm", "pack", "--destination", dir], {
        cwd: join(dir, "src", p),
      });
    const bun = (args: string[]) =>
      expect(spawnSync(process.execPath, args, { cwd: dir }).status).toBe(0);
    bun(["install"]);
    const lock = join(dir, "bun.lock");
    const pinned = readFileSync(lock, "utf8").replace(
      /("c": \["c@[^"]*", \{ "dependencies": \{ "b": "1\.0\.0" \})/,
      '$1, "os": "none"',
    );
    expect(pinned).toContain('"os": "none"');
    writeFileSync(lock, pinned);
    rmSync(join(dir, "node_modules"), { recursive: true });
    bun(["install", "--frozen-lockfile"]);
    expect(existsSync(join(dir, "node_modules/b"))).toBe(false);
    expect(run(dir, "check-licenses")).toEqual({ code: 0, out: "" });
    const lockWithPeer = pinned.replace(
      '"name": "fx",',
      `"name": "fx", "peerDependencies": { "constructor": "*" },`,
    );
    expect(lockWithPeer).not.toBe(pinned);
    writeFileSync(lock, lockWithPeer);
    expect(run(dir, "check-licenses")).toEqual({ code: 0, out: "" });
    writeFileSync(lock, pinned);
    rmSync(join(dir, "node_modules/a/node_modules/b"), { recursive: true });
    const unbundled = run(dir, "check-licenses");
    expect(unbundled.code).toBe(1);
    expect(unbundled.out).toContain("a/b");
  });

  test("check-staged runs it when bun.lock or package.json is staged", () => {
    const dir = installed(
      { planted: license("GPL-3.0-only") },
      { private: true, allow: [{ check: "coupling", path: "package.json", reason: "fixture" }] },
    );
    write(dir, { "notes.txt": "x\n" });
    sh(dir, ["add", "notes.txt"]);
    expect(run(dir, "check-staged").out).not.toContain("[check-licenses]");
    write(dir, { "package.json": readFileSync(join(dir, "package.json"), "utf8") + "\n" });
    sh(dir, ["add", "package.json"]);
    const r = run(dir, "check-staged");
    expect(r.code).toBe(1);
    expect(r.out).toContain("[check-licenses] planted");
  });
});

describe("chrome", () => {
  test("CHROME_BINARY wins, else the build puppeteer-core pins, else the newest cached build of this platform, the shell on request", async () => {
    const { cachedChrome, chromeBinary } = await import("../lib/chrome.ts");
    const cache = temp();
    const platform =
      process.platform === "darwin" ? (process.arch === "arm64" ? "mac_arm" : "mac") : "linux";
    const exe =
      process.platform === "darwin"
        ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        : "chrome";
    const plant = (kind: string, build: string, file: string) => {
      const path = join(cache, kind, build, `${kind}-x`, file);
      write("/", { [path]: "" });
      return path;
    };
    const pinned = plant("chrome", `${platform}-9.0.1`, exe);
    const newest = plant("chrome", `${platform}-10.0.1`, exe);
    plant("chrome", `other-99.0.0`, exe);
    const shell = plant("chrome-headless-shell", `${platform}-10.0.1`, "chrome-headless-shell");
    const saved = { ...process.env };
    const cwd = process.cwd();
    process.env.PUPPETEER_CACHE_DIR = cache;
    delete process.env.CHROME_BINARY;
    try {
      expect(cachedChrome()).toBe(newest);
      expect(cachedChrome({ shell: true })).toBe(shell);
      // An install under way, or one that died, keeps its archive beside the build's folder, which
      // already holds the executable while the rest is still being unpacked.
      const unpacking = plant("chrome", `${platform}-11.0.1`, exe);
      write(cache, { "chrome/11.0.1-chrome-x.zip": "" });
      expect(cachedChrome()).toBe(newest);
      rmSync(join(cache, "chrome/11.0.1-chrome-x.zip"));
      expect(cachedChrome()).toBe(unpacking);
      rmSync(join(cache, "chrome", `${platform}-11.0.1`), { recursive: true });
      // A consumer's puppeteer-core decides the build, the shell's absent pin finds nothing.
      const consumer = temp();
      write(consumer, {
        "node_modules/puppeteer-core/package.json": JSON.stringify({
          name: "puppeteer-core",
          type: "module",
          exports: { "./internal/*": "./lib/puppeteer/*" },
        }),
        "node_modules/puppeteer-core/lib/puppeteer/revisions.js":
          "export const PUPPETEER_REVISIONS = { chrome: '9.0.1', 'chrome-headless-shell': '8.0.1' };\n",
      });
      process.chdir(consumer);
      expect(cachedChrome()).toBe(pinned);
      expect(cachedChrome({ shell: true })).toBeUndefined();
      process.env.CHROME_BINARY = "/opt/own-chrome";
      expect(chromeBinary()).toBe("/opt/own-chrome");
    } finally {
      process.chdir(cwd);
      process.env = saved;
    }
  });

  test("on an empty cache, concurrent calls share one install, a found path is kept, a failed install runs again", async () => {
    const { chromeBinaryAsync } = await import("../lib/chrome.ts");
    const dir = temp();
    const rel = join("chrome", "mac_arm-11.0.1", "chrome-x", "chrome");
    const chrome = join(dir, "empty-cache", rel);
    const log = join(dir, "installs.log");
    const flag = join(dir, "install-fails");
    // Stands in for @puppeteer/browsers: logs each run, fails while the flag file exists, else
    // unpacks into the folder after --path.
    write(dir, {
      "bin/bunx": `#!/bin/sh\necho run >> "${log}"\nsleep 0.3\n[ -e "${flag}" ] && exit 1\nwhile [ "$1" != --path ]; do shift; done\nmkdir -p "$(dirname "$2/${rel}")"\n: > "$2/${rel}"\necho "$2/${rel}"\n`,
      "install-fails": "",
    });
    chmodSync(join(dir, "bin/bunx"), 0o755);
    const runs = () => readFileSync(log, "utf-8").split("\n").filter(Boolean).length;
    const saved = { ...process.env };
    process.env.PATH = `${join(dir, "bin")}:${process.env.PATH}`;
    process.env.PUPPETEER_CACHE_DIR = join(dir, "empty-cache");
    delete process.env.CHROME_BINARY;
    try {
      expect(await chromeBinaryAsync()).toBeUndefined();
      rmSync(flag);
      expect(await Promise.all([chromeBinaryAsync(), chromeBinaryAsync()])).toEqual([
        chrome,
        chrome,
      ]);
      expect(runs()).toBe(2);
      expect(await chromeBinaryAsync()).toBe(chrome);
      expect(runs()).toBe(2);
    } finally {
      process.env = saved;
    }
  });

  // An install over the unpack took the half-unpacked folder and deleted the archive marking it.
  test(
    "waits for another job's unpack of the build instead of installing over it",
    async () => {
      const { chromeBinary, chromeBinaryAsync } = await import("../lib/chrome.ts");
      const dir = temp();
      const cache = join(dir, "cache");
      const platform =
        process.platform === "darwin" ? (process.arch === "arm64" ? "mac_arm" : "mac") : "linux";
      const exe =
        process.platform === "darwin"
          ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
          : "chrome";
      let chrome = join(cache, "chrome", `${platform}-11.0.1`, "chrome-x", exe);
      let archive = join(cache, "chrome", "11.0.1-chrome-x.zip");
      const log = join(dir, "installs.log");
      write("/", { [chrome]: "", [archive]: "" });
      write(dir, {
        "bin/bunx": `#!/bin/sh\necho run >> "${log}"\necho "${chrome}"\n`,
        "node_modules/puppeteer-core/package.json": JSON.stringify({
          name: "puppeteer-core",
          type: "module",
          exports: { "./internal/*": "./lib/puppeteer/*" },
        }),
        "node_modules/puppeteer-core/lib/puppeteer/revisions.js":
          "export const PUPPETEER_REVISIONS = { chrome: '11.0.1' };\n",
      });
      chmodSync(join(dir, "bin/bunx"), 0o755);
      const saved = { ...process.env };
      const cwd = process.cwd();
      process.env.PATH = `${join(dir, "bin")}:${process.env.PATH}`;
      process.env.PUPPETEER_CACHE_DIR = cache;
      delete process.env.CHROME_BINARY;
      process.chdir(dir);
      try {
        setTimeout(() => rmSync(archive), 1_500);
        expect(await chromeBinaryAsync()).toBe(chrome);
        expect(existsSync(archive)).toBe(false);
        expect(existsSync(log)).toBe(false);
        // The blocking form, in a cache of its own, from a second process that ends the unpack.
        process.env.PUPPETEER_CACHE_DIR = join(dir, "cache2");
        chrome = join(dir, "cache2", "chrome", `${platform}-11.0.1`, "chrome-x", exe);
        archive = join(dir, "cache2", "chrome", "11.0.1-chrome-x.zip");
        write("/", { [chrome]: "", [archive]: "" });
        Bun.spawn(["sh", "-c", `sleep 1.5; rm "${archive}"`]);
        expect(chromeBinary()).toBe(chrome);
        expect(existsSync(archive)).toBe(false);
        expect(existsSync(log)).toBe(false);
      } finally {
        process.chdir(cwd);
        process.env = saved;
      }
    },
    limit(30_000),
  );

  // An install that died left its archive beside a half-unpacked build, which a gate took for 15
  // minutes, and an install in the cache's own folder returned that build as it stood.
  test(
    "installs into a folder of its own and replaces a build whose install died",
    async () => {
      const { cachedChrome, chromeBinary } = await import("../lib/chrome.ts");
      const dir = temp();
      const cache = join(dir, "cache");
      const platform =
        process.platform === "darwin" ? (process.arch === "arm64" ? "mac_arm" : "mac") : "linux";
      const exe =
        process.platform === "darwin"
          ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
          : "chrome";
      const rel = join("chrome", `${platform}-11.0.1`, "chrome-x", exe);
      const archive = join(cache, "chrome", "11.0.1-chrome-x.zip");
      write(cache, { [rel]: "half", "chrome/11.0.1-chrome-x.zip": "" });
      const old = new Date(Date.now() - 600_000);
      utimesSync(archive, old, old);
      // Stands in for @puppeteer/browsers: unpacks into the folder after --path.
      write(dir, {
        "bin/bunx": `#!/bin/sh\nwhile [ "$1" != --path ]; do shift; done\nmkdir -p "$(dirname "$2/${rel}")"\nprintf whole > "$2/${rel}"\necho "$2/${rel}"\n`,
      });
      chmodSync(join(dir, "bin/bunx"), 0o755);
      const saved = { ...process.env };
      process.env.PATH = `${join(dir, "bin")}:${process.env.PATH}`;
      process.env.PUPPETEER_CACHE_DIR = cache;
      delete process.env.CHROME_BINARY;
      try {
        expect(cachedChrome({ anyBuild: true })).toBeUndefined();
        const started = Date.now();
        expect(chromeBinary()).toBe(join(cache, rel));
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(readFileSync(join(cache, rel), "utf-8")).toBe("whole");
        expect(existsSync(archive)).toBe(false);
        expect(readdirSync(cache).filter((name) => name.startsWith(".install-"))).toEqual([]);
        expect(cachedChrome({ anyBuild: true })).toBe(join(cache, rel));
        // A download killed before its unpack leaves the archive alone, which read as a build that died.
        process.env.PUPPETEER_CACHE_DIR = join(dir, "cache2");
        write(join(dir, "cache2"), { "chrome/11.0.1-chrome-x.zip": "" });
        utimesSync(join(dir, "cache2/chrome/11.0.1-chrome-x.zip"), old, old);
        expect(chromeBinary()).toBe(join(dir, "cache2", rel));
        expect(existsSync(join(dir, "cache2/chrome/11.0.1-chrome-x.zip"))).toBe(false);
        // An unpack that threw leaves the build's folder without its executable, and no archive.
        process.env.PUPPETEER_CACHE_DIR = join(dir, "cache3");
        write(join(dir, "cache3"), {
          [join("chrome", `${platform}-11.0.1`, "chrome-x", "partial")]: "",
        });
        expect(chromeBinary()).toBe(join(dir, "cache3", rel));
      } finally {
        process.env = saved;
      }
    },
    limit(30_000),
  );
});

describe("chrome-mcp", () => {
  test(
    "starts the pinned chrome-devtools MCP server, which opens a page in Chrome for Testing",
    async () => {
      const server = Bun.spawn([process.execPath, "--no-env-file", bin("chrome-mcp")], {
        cwd: join(import.meta.dirname, ".."),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      let out = "";
      void (async () => {
        for await (const chunk of server.stdout) out += new TextDecoder().decode(chunk);
      })();
      const call = async (id: number, method: string, params: object) => {
        await server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        for (const end = Date.now() + 60_000; Date.now() < end; await Bun.sleep(100)) {
          const line = out.split("\n").find((l) => l.includes(`"id":${id}`));
          if (line) return jsonObject(line).result;
        }
        throw new Error(`no answer to ${method}`);
      };
      try {
        const init = await call(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        });
        expect(member(init, "serverInfo", "version")).toBe(
          ownPackage.dependencies["chrome-devtools-mcp"],
        );
        await server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
        const pages = await call(2, "tools/call", { name: "list_pages", arguments: {} });
        expect(member(pages, "content", 0, "text")).toContain("about:blank");
      } finally {
        server.kill("SIGTERM");
        await server.exited;
      }
    },
    limit(120_000),
  );

  test(
    "starts on any cached build where the pinned one is missing, without a download",
    async () => {
      const cache = temp();
      const platform =
        process.platform === "darwin" ? (process.arch === "arm64" ? "mac_arm" : "mac") : "linux";
      const exe =
        process.platform === "darwin"
          ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
          : "chrome";
      write("/", { [join(cache, "chrome", `${platform}-10.0.1`, "chrome-x", exe)]: "" });
      const consumer = temp();
      write(consumer, {
        "node_modules/puppeteer-core/package.json": JSON.stringify({
          name: "puppeteer-core",
          type: "module",
          exports: { "./internal/*": "./lib/puppeteer/*" },
        }),
        "node_modules/puppeteer-core/lib/puppeteer/revisions.js":
          "export const PUPPETEER_REVISIONS = { chrome: '9.0.1' };\n",
      });
      // Stands in for @puppeteer/browsers: logs a download and fails it.
      const fake = temp();
      const log = join(fake, "bunx.log");
      writeFileSync(join(fake, "bunx"), `#!/bin/sh\necho "$*" >> "${log}"\nexit 1\n`, {
        mode: 0o755,
      });
      const env: Record<string, string | undefined> = {
        ...process.env,
        PUPPETEER_CACHE_DIR: cache,
        PATH: `${fake}:${process.env.PATH}`,
        // Empty counts as unset, as chromeBinary reads it.
        CHROME_BINARY: "",
      };
      const server = Bun.spawn([process.execPath, "--no-env-file", bin("chrome-mcp")], {
        cwd: consumer,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      await server.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })}\n`,
      );
      let out = "";
      const reader = server.stdout.getReader();
      try {
        for (const end = Date.now() + 30_000; !out.includes('"id":1') && Date.now() < end;) {
          const { value, done } = await reader.read();
          if (done) break;
          out += new TextDecoder().decode(value);
        }
      } finally {
        server.kill("SIGTERM");
        await server.exited;
      }
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
      expect(out).toContain("chrome_devtools");
    },
    limit(60_000),
  );
});

describe("serve", () => {
  test("two servers started at once get their own ports; one that exits fails at once", async () => {
    const { serve } = await import("../lib/serve.ts");
    const app = join(temp(), "app.ts");
    writeFileSync(
      app,
      "Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => new Response(process.env.PORT) });\n",
    );
    const [a, b] = await Promise.all([
      serve([process.execPath, app]),
      serve([process.execPath, app]),
    ]);
    try {
      expect(a.url).not.toBe(b.url);
      expect(await (await fetch(a.url)).text()).toBe(new URL(a.url).port);
      expect(await (await fetch(b.url)).text()).toBe(new URL(b.url).port);
    } finally {
      a.stop();
      b.stop();
    }
    const started = Date.now();
    expect(await rejection(serve([process.execPath, "-e", "process.exit(3)"]))).toContain(
      "it exited",
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await rejection(serve(["/nonexistent-polish-bin"]))).toContain("it exited");
  });

  test("stderr: true passes the server's stderr through; by default it stays quiet", () => {
    const lib = JSON.stringify(join(import.meta.dirname, "..", "lib", "serve.ts"));
    const said = (options: string) =>
      spawnSync(
        process.execPath,
        [
          "-e",
          `const { serve } = await import(${lib});
await serve([process.execPath, "-e", "console.error('boot failed: stack'); process.exit(1)"], ${options}).catch(() => {});`,
        ],
        { encoding: "utf8" },
      ).stderr;
    expect(said("{ stderr: true }")).toContain("boot failed: stack");
    expect(said("{}")).not.toContain("boot failed");
  });

  test("a server that exits first names its exit code and the end of its stderr", async () => {
    const { serve } = await import("../lib/serve.ts");
    const crash =
      "console.error('x'.repeat(5000)); console.error('boot failed: stack'); process.exit(7)";
    const message = await rejection(serve([process.execPath, "-e", crash]));
    expect(message).toContain("it exited with code 7");
    expect(message).toContain("boot failed: stack");
    expect(message.length).toBeLessThan(3000);
  });

  test("the load factor is load per core, from 1 up to 10", () => {
    const factor = (load: string) =>
      Number(
        spawnSync(
          process.execPath,
          [
            "-e",
            `console.log((await import(${JSON.stringify(join(import.meta.dirname, "..", "lib", "serve.ts"))})).machineLoad().factor)`,
          ],
          { env: { ...process.env, SCAFFOLDING_LOAD: load }, encoding: "utf8" },
        ).stdout,
      );
    const cores = availableParallelism();
    expect(factor("0")).toBe(1);
    expect(factor(String(cores * 3))).toBe(3);
    expect(factor(String(cores * 50))).toBe(10);
  });

  test(
    "an answer that arrives after the server exited is not its own",
    async () => {
      const { serve } = await import("../lib/serve.ts");
      const foreign = join(temp(), "foreign.ts");
      writeFileSync(
        foreign,
        "Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: async () => { await Bun.sleep(3000); return new Response('foreign'); } });\n",
      );
      // The command exits while a request to another listener on its port is still open.
      const command = ["sh", "-c", `${process.execPath} ${foreign} & sleep 1; exit 1`];
      expect(await rejection(serve(command, { timeoutMs: 10_000 }))).toContain("it exited");
    },
    limit(20_000),
  );

  test(
    "a server that accepts but never answers fails at the timeout",
    async () => {
      const { serve } = await import("../lib/serve.ts");
      const silent = `require("node:net").createServer(() => {}).listen(Number(process.env.PORT), process.env.HOST)`;
      const started = Date.now();
      expect(
        await rejection(serve([process.execPath, "-e", silent], { timeoutMs: 500 })),
      ).toContain("no answer");
      expect(Date.now() - started).toBeLessThan(5_000);
    },
    limit(10_000),
  );

  for (const stopped of [true, false])
    test(
      `${stopped ? "stop()" : "SIGKILL to the process that served"} ends a server behind a wrapper`,
      async () => {
        const app = join(temp(), "app.ts");
        writeFileSync(
          app,
          "Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => new Response(String(process.pid)) });\n",
        );
        // `; :` keeps sh as the parent, so the server is a grandchild.
        const wrapped = JSON.stringify(["sh", "-c", `${process.execPath} ${app}; :`]);
        const parent = Bun.spawn(
          [
            process.execPath,
            "-e",
            `const s = await (await import(${JSON.stringify(join(import.meta.dirname, "..", "lib", "serve.ts"))})).serve(${wrapped}); console.log(await (await fetch(s.url)).text()); ${stopped ? "s.stop();" : "await new Promise(() => {});"}`,
          ],
          { stdout: "pipe" },
        );
        try {
          let line = "";
          const decoder = new TextDecoder();
          for await (const chunk of parent.stdout) {
            line += decoder.decode(chunk);
            if (line.includes("\n")) break;
          }
          const pid = Number(line);
          expect(pid).toBeGreaterThan(0);
          if (!stopped) parent.kill("SIGKILL");
          const alive = () => {
            try {
              return process.kill(pid, 0);
            } catch {
              return false;
            }
          };
          for (const end = Date.now() + 5_000; alive() && Date.now() < end;) await Bun.sleep(100);
          expect(alive()).toBe(false);
        } finally {
          parent.kill("SIGKILL");
        }
      },
      limit(15_000),
    );
});

const shellScript = '#!/bin/sh\nunused=1\nprintf "%s\\n" ok\n';
const shellStyleFinding = '#!/bin/sh\nprintf "%s\\n" "`printf ok`"\n';
const checkedShell = (dir: string, env?: Record<string, string>) =>
  run(dir, "scaffolding", ["shell"], env);

test("shell input discovery uses the index shebang and ignores grep.patternType", () => {
  const dir = repo({
    "with space": "#!/usr/bin/env -S bash\ntrue\n",
    "tool.py": "#!/bin/sh\ntrue\n",
    later: "text\n#!/bin/sh\n",
    plain: "text\n",
  });
  expect(sh(dir, ["config", "grep.patternType", "fixed"]).status).toBe(0);
  write(dir, { "with space": "#!/usr/bin/env python\n" });
  expect(gitShellShebangs(dir, ["with space", "later", "plain"])).toEqual(["with space"]);
  expect(gitShellShebangs(dir, ["with space", "later"], "HEAD")).toEqual(["with space"]);
  expect(shellInput("with space", join(dir, "with space"))).toBe(false);
  expect(shellInput("tool.py", join(dir, "tool.py"))).toBe(false);
  expect(shellInput("a.bash", join(dir, "a.bash"))).toBe(true);
});

test("tracked inputs exclude symlinks, dependencies and unmerged index entries", () => {
  const dir = repo({
    "keep.sh": "#!/bin/sh\n",
    "missing.sh": "#!/bin/sh\n",
    "conflict.sh": "#!/bin/sh\n",
  });
  symlinkSync("keep.sh", join(dir, "linked.sh"));
  write(dir, { "node_modules/dependency.sh": "#!/bin/sh\n" });
  expect(sh(dir, ["add", "-f", "--", "linked.sh", "node_modules/dependency.sh"]).status).toBe(0);
  const hash = sh(dir, ["rev-parse", ":conflict.sh"]).stdout.toString().trim();
  const conflict = `0 ${"0".repeat(hash.length)}\tconflict.sh\n100644 ${hash} 1\tconflict.sh\n`;
  expect(sh(dir, ["update-index", "--index-info"], conflict).status).toBe(0);
  rmSync(join(dir, "missing.sh"));
  expect(indexInputs(dir, "*.sh")).toEqual(["keep.sh", "missing.sh"]);
  expect(trackedInputs(dir, "*.sh")).toEqual(["keep.sh"]);
});

const shellcheckPreload = {
  BUN_OPTIONS: `--preload=${join(import.meta.dirname, "shellcheck-preload.ts")}`,
};

async function realShellcheckFixture(dir: string) {
  const binary = await shellcheckBinary(join(import.meta.dirname, ".."));
  const path = join(dir, "node_modules/.cache/scaffolding/shellcheck-fixture");
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(binary, path);
  return { ...shellcheckPreload, SCAFFOLDING_TEST_SHELLCHECK: path };
}

function shellcheckFixture(
  dir: string,
  body = `#!/bin/sh
while [ "$1" != -- ]; do shift; done
shift
status=0
for file do
  if grep -q '^unused=1$' "$file" && ! grep -qs '^disable=SC2034$' .shellcheckrc; then
    printf 'In %s line 2: SC2034\n' "$file"
    status=1
  fi
  if [ "$file" = a.sh ] && grep -qs '^external-sources=true$' .shellcheckrc &&
    ! grep -qs '^foo=' lib.sh; then
    echo SC2154
    status=1
  fi
done
exit "$status"
`,
) {
  const file = "node_modules/.cache/scaffolding/shellcheck-fixture";
  write(dir, { [file]: body });
  const path = join(dir, file);
  chmodSync(path, 0o755);
  return { ...shellcheckPreload, SCAFFOLDING_TEST_SHELLCHECK: path };
}

describe("scaffolding shell", () => {
  test.each(["tracked script", "sourced script"])(
    "fails on a style finding in a %s",
    async (input) => {
      const script = input === "tracked script" ? shellStyleFinding : "#!/bin/sh\n. ./lib.sh\n";
      const dir = repo({ "main.sh": script });
      if (input === "sourced script") write(dir, { "lib.sh": shellStyleFinding });
      const red = checkedShell(dir, await realShellcheckFixture(dir));
      expect(red.code, red.out).toBe(1);
      expect(red.out).toContain(input === "tracked script" ? "In main.sh" : "In ./lib.sh");
      expect(red.out).toContain("SC2006 (style)");
    },
  );

  test("checks shell extensions and shebangs, honors .shellcheckrc and ignores other scripts", () => {
    const dir = repo({
      "with space.sh": shellScript,
      "with env": shellScript.replace("/bin/sh", "/usr/bin/env -S bash"),
      "check-lock.ts": shellScript,
      "helper.py": shellScript,
      other: "#!/usr/bin/env python\n",
    });
    write(dir, { "untracked.sh": shellScript });
    const env = shellcheckFixture(dir);
    const red = checkedShell(dir, env);
    expect(red.code).toBe(1);
    expect(red.out).toContain("In with space.sh line 2");
    expect(red.out).toContain("In with env line 2");
    expect(red.out).toContain("SC2034");
    expect(red.out).not.toMatch(/check-lock\.ts|helper\.py|untracked\.sh/);

    write(dir, { ".shellcheckrc": "disable=SC2034\n" });
    expect(checkedShell(dir, env)).toEqual({ code: 0, out: "" });
  });

  test("passes with no tracked shell scripts without creating a cache", () => {
    const dir = repo({ "check-lock.ts": shellScript });
    const run = checkedShell(dir);
    expect(run.code).toBe(0);
    expect(run.out).toContain("no tracked shell scripts");
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });

  test.each([
    ["unavailable", "HTTP 503"],
    ["corrupt", "archive checksum mismatch"],
  ])("reports a %s download in one line and exits red", (response, reason) => {
    const dir = repo({ "script.sh": shellScript });
    const cache = join(dir, "node_modules/.cache/scaffolding/shellcheck/v0.11.0");
    const staleDownload = join(cache, "download-2147483647-ABCdef");
    const staleSnapshot = join(cache, "staged-2147483647-ABCdef");
    const live = join(cache, `staged-${process.pid}-ABCdef`);
    for (const path of [staleDownload, staleSnapshot, live]) mkdirSync(path, { recursive: true });
    const r = checkedShell(dir, {
      ...shellcheckPreload,
      SCAFFOLDING_TEST_SHELLCHECK_RESPONSE: response,
    });
    expect(r.code).toBe(1);
    expect(r.out.trim().split("\n")).toEqual([
      expect.stringMatching(
        new RegExp(`^\\[shell\\] could not download ShellCheck v0\\.11\\.0 for .*: ${reason}$`),
      ),
    ]);
    expect(readdirSync(cache)).toEqual([relative(cache, live)]);
  });

  test("reports a signaled ShellCheck even when it has no exit status", () => {
    const dir = repo({ "script.sh": shellScript });
    expect(checkedShell(dir, shellcheckFixture(dir, '#!/bin/sh\nkill -TERM "$$"\n'))).toEqual({
      code: 1,
      out: "[shell] ShellCheck terminated by SIGTERM\n",
    });
  });
});

test.each([".githooks/pre-push", "template/.githooks/pre-push"])(
  "%s clears Git-local variables and passes each branch range to the gate",
  (path) => {
    const dir = repo({});
    const fake = join(dir, "node_modules", ".bin");
    mkdirSync(fake, { recursive: true });
    writeFileSync(
      join(fake, "bun"),
      '#!/bin/sh\n[ "$3" = check ] || exit 0\nprintf "%s\\n" "${GIT_DIR-unset}" "${GIT_INDEX_FILE-unset}" "$@"\n',
      { mode: 0o755 },
    );
    const hook = join(import.meta.dirname, "..", path);
    const push = (input: string) =>
      spawnSync(hook, ["origin", "remote"], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${fake}:${process.env.PATH}`,
          GIT_DIR: ".git",
          GIT_INDEX_FILE: "custom",
        },
        input,
        encoding: "utf8",
      });
    const r = push("refs/heads/a a1 refs/heads/a a0\nrefs/heads/b b1 refs/heads/b b0\n");
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      "unset",
      "unset",
      "run",
      "--silent",
      "check",
      "--changed",
      "a0..a1",
      "b0..b1",
    ]);
    for (const refs of [
      "",
      "refs/tags/v1 a1 refs/tags/v1 a0\n",
      "(delete) 0000 refs/heads/a a0\n",
    ]) {
      const empty = push(refs);
      expect(empty.status).toBe(0);
      expect(empty.stdout).toBe("");
    }
  },
);

describe("scaffolding markdown", () => {
  const check = (dir: string, ...args: string[]) => run(dir, "scaffolding", ["markdown", ...args]);
  const bad = "Body without a title.\n";

  test("recognizes top-level frontmatter titles and limits H1s in the body", () => {
    const dir = repo({
      "title.md": "---\ntitle: Record\n---\n\n" + bad,
      "name.md": "---\nname: Record\n---\n\n" + bad,
      "nested.md": "---\nmetadata:\n  title: Record\n  name: Record\n---\n\n" + bad,
      "single.md": "---\ntitle: Record\n---\n\n# One\n",
      "double.md": "---\nname: Record\n---\n\n# One\n\n# Two\n",
    });
    const r = check(dir);
    expect(r.code).toBe(1);
    expect(r.out.trim().split("\n")).toEqual([
      expect.stringMatching(/^double\.md:7 error MD025\b/),
      expect.stringMatching(/^nested\.md:7 error MD041\b/),
      markdownRepair,
    ]);
  });

  test("uses only the shared rules on literal tracked files, ignoring symlinks and gitlinks", () => {
    const dir = repo({
      "[tracked].md": bad,
      "src/.markdownlint.json": '{"MD041":false}\n',
      "src/inline.md": "<!-- markdownlint-disable MD041 -->\n\n" + bad,
      "title.md": "---\ntitle: Record\n---\n\n" + bad,
    });
    const sub = repo({ "submodule.md": bad });
    const tip = sh(sub, ["rev-parse", "HEAD"]).stdout.toString().trim();
    cpSync(sub, join(dir, "sub"), { recursive: true });
    symlinkSync("[tracked].md", join(dir, "linked.md"));
    write(dir, {
      "untracked.md": bad,
      "node_modules/tracked-dependency.md": bad,
    });
    expect(
      sh(dir, ["add", "-f", "--", "linked.md", "node_modules/tracked-dependency.md"]).status,
    ).toBe(0);
    expect(sh(dir, ["update-index", "--add", "--cacheinfo", `160000,${tip},sub`]).status).toBe(0);
    const r = check(dir);
    expect(r.code).toBe(1);
    expect(r.out.trim().split("\n")).toEqual([
      expect.stringContaining("[tracked].md:1 error MD041"),
      expect.stringContaining("src/inline.md:3 error MD041"),
      markdownRepair,
    ]);
  });

  test("fixes trailing spaces and leaves the unfixable title finding and untracked content intact", () => {
    const text = "Body without a title. \n";
    const clean = "# Clean\n";
    const dir = repo({ "tracked.md": text, "clean.md": clean });
    write(dir, { "untracked.md": text });
    const before = check(dir);
    expect(before.code).toBe(1);
    expect(before.out).toContain("MD009");
    expect(before.out).toContain("MD041");
    expect(readFileSync(join(dir, "tracked.md"), "utf8")).toBe(text);

    const fixed = check(dir, "--fix");
    expect(fixed.code).toBe(1);
    expect(fixed.out).toContain("MD041");
    expect(fixed.out).not.toContain("MD009");
    expect(sh(dir, ["diff", "--name-only"]).stdout.toString()).toBe("tracked.md\n");
    expect(readFileSync(join(dir, "tracked.md"), "utf8")).toBe(bad);
    expect(readFileSync(join(dir, "untracked.md"), "utf8")).toBe(text);
  });
});
