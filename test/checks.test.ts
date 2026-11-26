import {
  afterAll,
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  TestRunner,
  vi,
} from "vitest";
import { auditAllow } from "../lib/allow-entries.ts";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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
import { ChangedStepSelector } from "../lib/changed-steps.ts";
import { catalogPath } from "../catalog/path.ts";
import { loadRoute, readRouteUntilRewritten, rewriteRoute } from "../catalog/route.ts";
import {
  oxlintConfiguration,
  oxlintFiles,
  oxlintRestrictionFindings,
  runOxlint,
} from "../lib/oxlint.ts";
import { ESLint } from "eslint";
import { activeSeverity } from "../lib/lint-rule-overlaps.ts";
import { defined } from "../lib/defined.ts";
import { rejection } from "../lib/rejection.ts";
import { gitShellShebangs, shellInput } from "../lib/shell-inputs.ts";
import { shellcheckBinary } from "../lib/shellcheck.ts";
import { indexInputs, trackedInputs } from "../lib/tracked-inputs.ts";
import {
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
import { limit } from "@hackersandwizards/scaffolding/test-timeout";
import { fileReady, until } from "./wait.ts";
import { testDirectory } from "./test-directory.ts";

/** The member of parsed JSON at `path`, undefined where a step meets no object or list. */
const member = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((v, key) => {
    if (isObject(v)) return v[key];
    const list: unknown[] = Array.isArray(v) ? v : [];
    return list[Number(key)];
  }, value);

const bin = (name: string) => join(import.meta.dirname, "..", "bin", `${name}.ts`);
const PREVIEW = 'ASTRO_PREVIEW_BACKGROUND=1 bun --bun astro preview --root "$PWD/catalog"';
const made: string[] = [];
const removeFixture = (dir: string) => rmSync(dir, { recursive: true, force: true });
afterAll(() => made.forEach(removeFixture));

const cache = join(import.meta.dirname, "..", "node_modules", ".cache", "scaffolding");
// A stopped run skips afterAll: the next run removes its folders once an hour old, so a run still
// going keeps its own.
function sweepFixtures(root: string) {
  for (const name of existsSync(root) ? readdirSync(root) : [])
    if (name.startsWith("scaffolding-test-"))
      try {
        const dir = join(root, name);
        if (Date.now() - statSync(dir).mtimeMs > 3_600_000)
          rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
}
for (const root of [tmpdir(), cache]) sweepFixtures(root);
function temp(root = tmpdir()) {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "scaffolding-test-"));
  if (TestRunner.getCurrentTest()) onTestFinished(() => removeFixture(dir));
  else made.push(dir);
  return dir;
}

describe("test fixture lifetime", () => {
  let dir: string;

  test("creates a temporary directory for the running test", () => {
    dir = temp();
    expect(existsSync(dir)).toBe(true);
  });

  afterAll(() => {
    expect(existsSync(dir)).toBe(false);
  });
});

test("fixture cleanup propagates filesystem errors besides disappearance", () => {
  const dir = temp();
  const name = "scaffolding-test-loop";
  symlinkSync(name, join(dir, name));
  expect(() => sweepFixtures(dir)).toThrow(/ELOOP/);
});
async function requestBrowserDebugPage(port: number, url: string) {
  let response: Response | undefined;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ECONNREFUSED") throw error;
  }
  if (response?.ok) return response;
  await Bun.sleep(100);
}

async function browserDebugTarget(port: number, url: string) {
  for (let i = 0; i < 100; i++) {
    const response = await requestBrowserDebugPage(port, url);
    if (!response) continue;
    const target = member(await response.json(), "webSocketDebuggerUrl");
    if (typeof target === "string") return target;
  }
  throw new Error("Chrome opened no page to attach to");
}

test("unexpected browser target failure surfaces", async () => {
  using request = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ webSocketDebuggerUrl: "ws://example.test" }))
    .mockRejectedValueOnce(new Error("debug target fault"));
  expect(await rejection(browserDebugTarget(1, "about:blank"))).toContain("debug target fault");
  expect(request).toHaveBeenCalledWith("http://127.0.0.1:1/json/new?about:blank", {
    method: "PUT",
  });
});

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
    const target = await browserDebugTarget(port, url);
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
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    input,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  });

/** Fail at the Git command that could not prepare the fixture. */
function prepareGit(dir: string, args: string[], input?: string) {
  const result = sh(dir, args, input);
  if (result.status === 0) return result.stdout.toString().trimEnd();
  throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.error ?? result.status}
${result.stdout}${result.stderr}`);
}

function prepareCommand(cwd: string, [command, ...args]: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, { cwd, env });
  if (result.status === 0) return result.stdout;
  throw new Error(
    `${command} ${args.join(" ")} failed in ${cwd}: ${result.error ?? result.status}\n${result.stdout}${result.stderr}`,
  );
}

function requireFixtureSuccess(command: string, code: number | null, output: string) {
  if (code === 0) return;
  throw new Error(`${command} could not prepare the fixture (exit ${code})\n${output}`);
}

function repo(files: Record<string, string>, commit = true, dir = temp()) {
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

function exploreFixture(runtime: "node" | "bun", folder?: string) {
  const dir = temp(cache);
  const property = "sample.prop.test.ts";
  write(dir, {
    "package.json": JSON.stringify({
      name: "property-consumer",
      type: "module",
      scripts: {
        explore: "scaffolding-explore",
        ...(folder ? { test: "scaffolding test" } : {}),
        "test:run": runtime === "bun" ? "bun --bun vitest run" : "vitest run",
        ...(runtime === "node" ? { "test:coverage": "vitest run --coverage" } : {}),
      },
      scaffolding: folder
        ? { browserTest: folder }
        : { test: runtime === "node" ? "test:coverage" : "test:run" },
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
  const installed = join(scope, "scaffolding");
  const commands = join(dir, "node_modules", ".bin");
  mkdirSync(join(installed, "node_modules"), { recursive: true });
  mkdirSync(commands, { recursive: true });
  for (const entry of ["package.json", "bin", "config", "lib"])
    cpSync(join(home, entry), join(installed, entry), { recursive: true });
  // Use two physical copies of the same Vitest version, as each has its own runner state.
  cpSync(join(home, "node_modules", "vitest"), join(installed, "node_modules", "vitest"), {
    recursive: true,
  });
  symlinkSync(join(home, "node_modules", "vitest"), join(dir, "node_modules", "vitest"));
  if (runtime === "node")
    symlinkSync(join(home, "node_modules", "@vitest"), join(dir, "node_modules", "@vitest"));
  symlinkSync(
    join(installed, "bin", "scaffolding-explore.ts"),
    join(commands, "scaffolding-explore"),
  );
  symlinkSync(join(home, "node_modules", ".bin", "vitest"), join(commands, "vitest"));
  const bun = realpathSync(process.execPath);
  const path = process.env.PATH?.split(delimiter)
    .filter((dir) => {
      const node = join(dir, "node");
      return !existsSync(node) || realpathSync(node) !== bun;
    })
    .join(delimiter);
  return { dir, property, path };
}

test("ordinary Node property tests still enforce the coverage threshold", () => {
  const { dir, property, path } = exploreFixture("node");
  const control = spawnSync(process.execPath, ["run", "test:coverage", property], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: path },
  });
  const output = control.stdout + control.stderr;
  expect(control.status, output).toBe(1);
  expect(output).toMatch(/Tests\s+2 passed/);
  expect(output).toMatch(/Coverage for lines .* does not meet global threshold/);
});

describe.each([
  { runtime: "node", folder: undefined },
  { runtime: "bun", folder: undefined },
  { runtime: "bun", folder: "test/pages" },
  { runtime: "bun", folder: "test/browser" },
] as const)(
  "the consumer explore command runs aliased properties on $runtime (browser folder $folder)",
  ({ runtime, folder }) => {
    let dir: string, property: string, path: string | undefined, source: string, config: string;
    beforeAll(() => {
      ({ dir, property, path } = exploreFixture(runtime, folder));
      source = readFileSync(join(dir, property), "utf8");
      config = readFileSync(join(dir, "vitest.config.mjs"), "utf8");
    });
    afterEach(() => write(dir, { [property]: source, "vitest.config.mjs": config }));
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
    test("reports the search plan and passes without coverage", () => {
      const result = explore();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("seed -188, 512 runs per property");
      expect(result.stdout).toMatch(/Tests\s+1 passed/);
      expect(result.stdout).not.toContain("Coverage enabled");
    });

    test("reports the original seed and shrunk counterexample", () => {
      write(dir, { [property]: source.replace("toBeGreaterThan(0)", "toBe(0)") });
      const failing = explore();
      expect(failing.status, failing.stdout + failing.stderr).toBe(1);
      const output = failing.stdout + failing.stderr;
      expect(output).toContain("with seed=-188");
      expect(output).toContain("Counterexample: [1]");
    });

    test("runs a direct test without the exploration plan", () => {
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
    });
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
  prepareGit(dir, ["config", "core.hooksPath", ".githooks"]);
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

const vitestImports = 'import { expect, test } from "vitest";\n';
const vitestExample = `${vitestImports}test("example", () => expect(1).toBe(1));`;
const thrownError = '() => { throw new Error("text"); }';
describe.each([
  {
    rule: "expect-expect",
    rules: ["expect-expect"],
    failing: 'import { test } from "vitest";\ntest("example", () => {});',
    passing: `${vitestImports}function expectSomething() { expect(1).toBe(1); }\ntest("example", () => expectSomething());`,
  },
  {
    rule: "no-conditional-expect in catch",
    rules: ["no-conditional-expect"],
    failing: `${vitestImports}test("bad JSON", () => {
      try { JSON.parse("bad"); } catch (error) { expect(error).toBeInstanceOf(SyntaxError); }
    });`,
    passing: `${vitestImports}test("bad JSON", () => expect(() => JSON.parse("bad")).toThrow(SyntaxError));`,
  },
  {
    rule: "no-focused-tests",
    rules: ["no-focused-tests"],
    failing: vitestExample.replace("test(", "test.only("),
    passing: vitestExample,
  },
  {
    rule: "no-disabled-tests",
    rules: ["no-disabled-tests"],
    failing: vitestExample.replace("test(", "test.skip("),
    passing: vitestExample,
  },
  {
    rule: "no-commented-out-tests",
    rules: ["no-commented-out-tests"],
    failing: "// it (something)\n",
    passing: vitestExample,
  },
  {
    rule: "no-identical-title",
    rules: ["no-identical-title"],
    failing: `import { describe, expect, test } from "vitest";
    describe("group", () => { test("first", () => expect(1).toBe(1)); test("first", () => expect(2).toBe(2)); });`,
    passing: `import { describe, expect, test } from "vitest";
    describe("group", () => { test("first", () => expect(1).toBe(1)); test("second", () => expect(2).toBe(2)); });`,
  },
  {
    rule: "valid-expect",
    rules: ["valid-expect"],
    failing: `${vitestImports}test("example", () => { expect(1); });`,
    passing: `${vitestImports}test("example", () => expect(1, "message").toBe(1));`,
  },
  {
    rule: "require-to-throw-message",
    rules: ["require-to-throw-message"],
    failing: `${vitestImports}test("error", () => expect(${thrownError}).toThrow());`,
    passing: `${vitestImports}test("error", () => expect(${thrownError}).toThrow("text"));`,
  },
  {
    rule: "valid-title",
    rules: ["valid-title"],
    failing: vitestExample.replace('"example"', '""'),
    passing: vitestExample,
  },
  {
    rule: "no-duplicate-hooks",
    rules: ["no-duplicate-hooks"],
    failing: `import { beforeEach, describe, expect, test } from "vitest";
    describe("group", () => { beforeEach(() => {}); beforeEach(() => {}); test("example", () => expect(1).toBe(1)); });`,
    passing: `import { beforeEach, describe, expect, test } from "vitest";
    describe("group", () => { beforeEach(() => {}); test("example", () => expect(1).toBe(1)); });`,
  },
  {
    rule: "no-import-node-test",
    rules: ["no-import-node-test"],
    failing: 'import "node:test";',
    passing: vitestExample,
  },
  {
    rule: "no-conditional-expect in if",
    rules: ["no-conditional-in-test", "no-conditional-expect"],
    failing: `${vitestImports}test("example", () => { expect(1).toBe(1); if (Number("1")) expect(1).toBe(1); });`,
    passing: vitestExample,
  },
] as const)("Oxlint Vitest: $rule", ({ rules, failing, passing }) => {
  let dir: string;
  beforeAll(() => {
    dir = repo({ ".oxlintrc.json": JSON.stringify(oxlintTemplate), "example.test.js": passing });
    install(dir);
  });
  afterEach(() => write(dir, { "example.test.js": passing }));
  const check = () =>
    spawnSync(process.execPath, ["--no-env-file", join(import.meta.dirname, "../lib/oxlint.ts")], {
      cwd: dir,
      encoding: "utf8",
    });

  test("reports the configured rule and its guide", () => {
    write(dir, { "example.test.js": failing });
    const red = check();
    expect(red.status, red.stdout + red.stderr).toBe(1);
    const [findings, ...guides] = red.stdout.split(/\n\n(?=\[guide\] )/);
    expect(guides.map((guide) => guide.trimEnd())).toEqual(rules.map(fixtureGuide));
    expect(Array.from(findings.matchAll(/vitest\(([^)]+)\)/g), ([, rule]) => rule)).toEqual(rules);
  });

  test("accepts the passing control without a guide", () => {
    const green = check();
    expect(green.status, green.stdout + green.stderr).toBe(0);
    expect(green.stdout).not.toContain("[guide]");
  });
});

const sixExpectations = Array.from({ length: 6 }, (_, n) => `expect(${n}).toBe(${n});`);
const fiveExpectations = sixExpectations.slice(0, 5).join("\n");
const expectationTest = (body: string) =>
  `${vitestImports}test("checks output", () => { ${body} });`;
const expectedValueCases = `${vitestImports}
const identity = (value) => value;
const numeric = (value) => Number([value].join(""));
test.each([
  { name: "a positive input", resolve: identity, input: 1, expected: 1 },
  { name: "zero", resolve: identity, input: 0, expected: 0 },
  { name: "null", resolve: identity, input: null, expected: null },
  { name: "undefined", resolve: identity, input: undefined, expected: undefined },
  { name: "the numeric fallback", resolve: numeric, input: undefined, expected: 0 },
])("uses the expected value for $name", ({ resolve, input, expected }) => {
  expect(resolve(input)).toBe(expected);
});`;
test.each([
  {
    name: "six expectations",
    source: expectationTest(sixExpectations.join("\n")),
    code: 1,
    findings: ["test/example.js:7:1 vitest(max-expects)"],
    guides: ["max-expects"],
  },
  {
    name: "five expectations",
    source: expectationTest(fiveExpectations),
    code: 0,
    findings: [],
    guides: [],
  },
  {
    name: "six expectations in a helper",
    source: `${vitestImports}function expectAll() { ${sixExpectations.join("\n")} }\ntest("checks helper output", () => expectAll());`,
    code: 1,
    findings: ["test/example.js:7:1 vitest(max-expects)"],
    guides: ["max-expects"],
  },
  {
    name: "if",
    source: expectationTest(
      "const input = 1; let result = 0; if (input) result = input; expect(result).toBe(1);",
    ),
    code: 1,
    findings: ["test/example.js:2:64 vitest(no-conditional-in-test)"],
    guides: ["no-conditional-in-test"],
  },
  {
    name: "conditional operator",
    source: expectationTest(
      "const input = 0; const result = input ? input : 0; expect(result).toBe(0);",
    ),
    code: 1,
    findings: ["test/example.js:2:63 vitest(no-conditional-in-test)"],
    guides: ["no-conditional-in-test"],
  },
  {
    name: "nullish coalescing",
    source: expectationTest(
      "const input = undefined; const result = input ?? 0; expect(result).toBe(0);",
    ),
    code: 1,
    findings: ["test/example.js:2:71 vitest(no-conditional-in-test)"],
    guides: ["no-conditional-in-test"],
  },
  {
    name: "a table with the same inputs and outputs",
    source: expectedValueCases,
    code: 0,
    findings: [],
    guides: [],
  },
])("Oxlint checks test design for $name", ({ source, code, findings, guides }) => {
  const dir = repo({ ".oxlintrc.json": JSON.stringify(oxlintTemplate), "test/example.js": source });
  install(dir);
  const result = spawnSync(
    process.execPath,
    ["--no-env-file", join(import.meta.dirname, "../lib/oxlint.ts")],
    { cwd: dir, encoding: "utf8" },
  );
  const [report, ...guideBlocks] = result.stdout.split(/\n\n(?=\[guide\] )/);
  const diagnostics = Array.from(
    report.matchAll(/^([^:\n]+):(\d+):(\d+): (?:error|warning) ([\w-]+\([\w-]+\)):/gm),
    ([, file, line, column, rule]) => `${file}:${line}:${column} ${rule}`,
  );
  expect(result.status, result.stdout + result.stderr).toBe(code);
  expect(diagnostics, report).toEqual(findings);
  expect(guideBlocks.map((guide) => guide.trimEnd())).toEqual(guides.map(fixtureGuide));
});

const branchChecks = 'if (open) console.log("open");\n';
const nestedChecks = (depth: number) =>
  `export function visit(open) { ${"if (open) { ".repeat(depth)}console.log(open); ${"} ".repeat(depth)}}\n`;
const functionLines = (count: number) =>
  `export function report() {\n// Report one sample per line.\n\n${'console.log("sample");\n'.repeat(count)}}\n`;
const fileLines = (count: number) =>
  "// Export the available values.\n\n" +
  Array.from({ length: count }, (_, index) => `export const value${index} = ${index};\n`).join("");

test.each<{ rule: string; failing: string; passing: Record<string, string> }>([
  {
    rule: "complexity",
    failing: `export function visit(open) {\n${branchChecks.repeat(10)}}\n`,
    passing: { "src/example.js": `export function visit(open) {\n${branchChecks.repeat(9)}}\n` },
  },
  {
    rule: "max-depth",
    failing: nestedChecks(5),
    passing: { "src/example.js": nestedChecks(4) },
  },
  {
    rule: "max-params",
    failing: "export function add(a, b, c, d) { return a + b + c + d; }\n",
    passing: { "src/example.js": "export function add(a, b, c) { return a + b + c; }\n" },
  },
  {
    rule: "max-lines-per-function",
    failing: functionLines(49),
    passing: { "src/example.js": functionLines(48), "example.spec.js": functionLines(49) },
  },
  {
    rule: "max-lines",
    failing: fileLines(301),
    passing: { "src/example.js": fileLines(300), "test/nested/example.js": fileLines(301) },
  },
])("Oxlint checks consumer code design for $rule", ({ rule, failing, passing }) => {
  const dir = repo({
    ".oxlintrc.json": JSON.stringify(oxlintTemplate),
    "src/example.js": failing,
  });
  install(dir);
  const check = () =>
    spawnSync(process.execPath, ["--no-env-file", join(import.meta.dirname, "../lib/oxlint.ts")], {
      cwd: dir,
      encoding: "utf8",
    });
  const red = check();
  expect(red.status, red.stdout + red.stderr).toBe(1);
  const [report, ...guides] = red.stdout.split(/\n\n(?=\[guide\] )/);
  const findings = Array.from(report.matchAll(/: error [\w-]+\(([\w-]+)\):/g), ([, id]) => id);
  expect(findings, report).toEqual([rule]);
  expect(guides.map((guide) => guide.trimEnd())).toEqual([fixtureGuide(rule)]);

  write(dir, passing);
  const green = check();
  expect(green.status, green.stdout + green.stderr).toBe(0);
  expect(green.stdout).not.toContain("[guide]");
});

test("Oxlint exempts Astro test fixtures from both length limits", () => {
  const source = `---\n${functionLines(49)}${fileLines(301)}---\n`;
  const dir = repo({
    ".oxlintrc.json": JSON.stringify(oxlintTemplate),
    "test/nested/example.astro": source,
    "example.spec.astro": source,
  });
  install(dir);
  const result = runOxlint(dir, ["."], true);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test("Oxlint enforces expect-expect in test folders and stays out of non-test files", () => {
  const file = "tests/nested/example.js";
  const dir = repo({
    ".oxlintrc.json": JSON.stringify(oxlintTemplate),
    [file]: `
      import { test } from "vitest";
      import * as fc from "fast-check";
      test("integer", () => fc.assert(fc.property(fc.integer(), Number.isInteger)));
    `,
    "src/example.js": "// it (something)\n",
    "src/example.astro": "---\n// it (something)\n---\n<p>Example</p>\n",
  });
  install(dir);
  const result = runOxlint(dir, ["."], true);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  write(dir, { [file]: 'import { test } from "vitest";\ntest("missing assertion", () => {});' });
  const missing = runOxlint(dir, ["."], true);
  expect(missing.status, missing.stdout + missing.stderr).toBe(1);
  expect(missing.stdout).toMatch(/^tests\/nested\/example\.js:.*vitest\(expect-expect\)/m);
});

describe("ESLint enforces the shared property API, budgets and exploration filenames", () => {
  let dir: string;
  const root = join(import.meta.dirname, "..");
  const property = "example.prop.test.js";
  const ordinary = "example.test.js";
  const imports = `import { fc as arbitraries, test as propertyTest } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";`;
  beforeAll(() => {
    dir = temp();
    write(dir, {
      "eslint.config.mjs": `export { default } from ${JSON.stringify(join(root, "config/eslint.js"))};`,
    });
  }, limit(10_000));
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
  test.each([
    ["shared property examples", property, shared(", { examples: [[1]] }")],
    [
      "an aliased Vitest example",
      ordinary,
      'import { test as example, expect } from "vitest"; example("works", () => expect(true).toBe(true));',
    ],
    [
      "a local fc helper",
      ordinary,
      'import { test, expect } from "vitest"; const fc = { assert: () => true }; test("local helper", () => expect(fc.assert()).toBe(true));',
    ],
  ])(
    "accepts %s",
    (_, file, source) => {
      expect(lint(file, source)).toEqual({ status: 0, output: "" });
    },
    limit(10_000),
  );
  test.each([
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
  ])(
    "rejects invalid property API case %# in %s",
    (file, source, message) => {
      const result = lint(file, source);
      expect(result.status, source + result.output).toBe(1);
      expect(result.output).toContain(message);
    },
    limit(10_000),
  );
});
// SCAFFOLDING_LOAD 0: the gate runs its steps side by side whatever this machine's load is.
function run(cwd: string, argv: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--no-env-file", ...argv], {
    cwd,
    env: { ...process.env, SCAFFOLDING_LOAD: "0", ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
// Vitest declares these asymmetric matchers as any. Expected values need only be unknown.
const matchingText = (pattern: RegExp): unknown => expect.stringMatching(pattern);
const containingText = (text: string): unknown => expect.stringContaining(text);
const withoutText = (text: string): unknown => expect.not.stringContaining(text);

const lines = (out: string, check: string) =>
  out.split("\n").filter((l) => l.startsWith(`[${check}]`) && !/ findings, \d+ ms$/.test(l));

function fixtureGuide(id: string) {
  return readFileSync(join(import.meta.dirname, "../config/guides", `${id}.md`), "utf8")
    .replace(/^# /, `[guide] ${id}: `)
    .trimEnd();
}

function expectGuide(out: string, ...ids: string[]) {
  for (const id of ids) {
    const guide = readFileSync(join(import.meta.dirname, "../config/guides", `${id}.md`), "utf8");
    expect(out).toContain(`\n\n${guide.replace(/^# /, `[guide] ${id}: `)}`);
  }
  expect(out.match(/^\[guide\] [^:]+/gm)).toEqual(ids.map((id) => `[guide] ${id}`));
}

function expectGuideAfter(out: string, id: string, finding: string) {
  expectGuide(out, id);
  const offset = out.indexOf(finding);
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(out.indexOf("[guide] ")).toBeGreaterThan(offset);
}

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
  "hard-coded path into an installed package: resolve it through the package's exports with import.meta.resolve (use ./package.json for the package folder), run its command from node_modules/.bin, or serve a catalog asset by its package path in the catalog preset's copy. Only if no export or bin fits, record the exception with a concrete reason in package.json scaffolding.allow";

const allowPairs = { check: "x", path: ["a", "b"], text: ["x", "y"], reason: "r" };
const staleAllow =
  "allow entry matches nothing: remove this stale entry (or unused path/text item) from package.json scaffolding.allow";
const malformedAllow =
  "allow entry's path and text are strings or lists of strings: fix this entry in package.json scaffolding.allow so path and text (when set) are each a string or string[]";
const rawFinding = (path: string, text: string, message = "m") => ({
  check: "x",
  path,
  text,
  message,
});
test.each([
  {
    scenario: "root and nested matches",
    entries: [{ check: "x", path: "**/x.ts", reason: "r" }],
    findings: [
      ["x.ts", "t"],
      ["a/b/x.ts", "t"],
    ],
    expected: [],
  },
  {
    scenario: "zero intermediate folders",
    entries: [{ check: "x", path: "a/**/b.ts", reason: "r" }],
    findings: [["a/b.ts", "t"]],
    expected: [],
  },
  {
    scenario: "every list item used",
    entries: [allowPairs],
    findings: [
      ["a", "x"],
      ["b", "y"],
    ],
    expected: [],
  },
  {
    scenario: "unused list items",
    entries: [allowPairs],
    findings: [["a", "x"]],
    expected: [
      rawFinding("package.json", JSON.stringify({ ...allowPairs, path: "b" }), staleAllow),
      rawFinding("package.json", JSON.stringify({ ...allowPairs, text: "y" }), staleAllow),
    ],
  },
  {
    scenario: "non-string path",
    entries: [{ check: "x", path: 5, reason: "r" }],
    findings: [["a", "t"]],
    expected: [
      rawFinding("a", "t"),
      rawFinding("package.json", '{"check":"x","path":5,"reason":"r"}', malformedAllow),
    ],
  },
] as const)("allow entries cover or explain $scenario", ({ entries, findings, expected }) => {
  expect(
    auditAllow(
      { scaffolding: { allow: [...entries] } } as Parameters<typeof auditAllow>[0],
      "x",
      findings.map(([path, text]) => rawFinding(path, text)),
    ),
  ).toEqual(expected);
});

// Before anything else runs: in an empty folder outside a repository, with neither gitleaks nor a
// Chrome to find.
describe("command help", () => {
  let dir: string;
  beforeAll(() => {
    dir = temp();
  });
  const help = (path: string, args = ["--help"]) =>
    spawnSync(process.execPath, ["--no-env-file", join(import.meta.dirname, "..", path), ...args], {
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", HOME: dir },
      encoding: "utf8",
    });
  const helpText = new Map(Object.keys(ownPackage.bin).map((name) => [name, "\nRuns in: "]));
  helpText.set("check-lock", "\nRuns the command under the checkout's lock:");
  const commands = Object.entries(ownPackage.bin).map(([name, path]) => ({
    name,
    path,
    text: helpText.get(name),
  }));

  test.each(commands)("$name answers --help first on stdout", ({ name, path, text }) => {
    const result = help(path);
    const [usage] = result.stdout.split("\n");
    expect({ status: result.status, stderr: result.stderr, usage }).toEqual({
      status: 0,
      stderr: "",
      usage: matchingText(new RegExp(`^usage: ${name}( |$)`)),
    });
    assert(text, "a help footer must be defined for this command");
    expect(result.stdout).toContain(text);
  });
  test("check-lock passes a later --help to its command", () => {
    expect(help(ownPackage.bin["check-lock"], ["echo", "--help"]).stdout).toBe("--help\n");
  });
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
    const r = run(fx, [bin("check-coupling")]);
    expect(r.code).toBe(1);
    const found = lines(r.out, "check-coupling");
    expect(found).toEqual([
      "[check-coupling] package.json: path leaves the repository; take it from the package its owner publishes (../other/util.ts)",
      "[check-coupling] package.json: path leaves the repository; take it from the package its owner publishes (../other)",
      "[check-coupling] src/__tests__/a.test.ts: path leaves the repository; take it from the package its owner publishes (../../../other/util)",
      "[check-coupling] src/bad-exports.ts: not in the exports of @acme/pkg: import a subpath listed in @acme/pkg's package.json exports, or add this subpath to @acme/pkg's exports and release a new tag; do not silence with scaffolding.allow (@acme/pkg/internal/secret.ts)",
      "[check-coupling] src/bad-sibling.ts: path leaves the repository; take it from the package its owner publishes (../../other/util)",
      "[check-coupling] styles/bad.css: path leaves the repository; take it from the package its owner publishes (../../other/theme.css)",
      "[check-coupling] styles/bad.css: not in the exports of @acme/pkg: import a subpath listed in @acme/pkg's package.json exports, or add this subpath to @acme/pkg's exports and release a new tag; do not silence with scaffolding.allow (@acme/pkg/internal/x.css)",
      "[check-coupling] package.json: Git dependency not pinned to a version tag: append a semver tag (#vX.Y.Z) to the Git URL in package.json (or run raise-pins), then run bun install (@acme/unpinned@github:acme/unpinned)",
      "[check-coupling] package.json: Git dependency not pinned to a version tag: append a semver tag (#vX.Y.Z) to the Git URL in package.json (or run raise-pins), then run bun install (@acme/branch@git+https://github.com/acme/branch.git#main)",
      "[check-coupling] package.json: local path dependency: replace the file:/link:/portal: specifier in package.json with a pinned Git tag (git+https://...#vX.Y.Z) or registry version, then run bun install (@acme/local@file:../other)",
    ]);
    expect(r.out).not.toContain("src/ok.ts");
    expect(r.out).not.toContain("escape");
    expect(r.out).not.toContain("registry@");
  });

  const installedPin = (version: string) => ({
    "node_modules/@acme/pkg/package.json": JSON.stringify({ version }),
  });
  test.each([
    { installation: "installed", files: installedPin("1.2.0"), code: 0, diagnostics: [] },
    {
      installation: "out of date",
      files: installedPin("1.1.0"),
      code: 1,
      diagnostics: [containingText("node_modules holds 1.1.0, not the pinned 1.2.0")],
    },
    {
      installation: "missing",
      files: {},
      code: 1,
      diagnostics: [containingText("node_modules holds nothing")],
    },
  ])(
    "check-coupling checks a Git pin with an $installation install",
    ({ files, code, diagnostics }) => {
      const dir = repo({
        "package.json": JSON.stringify({ dependencies: { "@acme/pkg": "github:acme/pkg#v1.2.0" } }),
        ...files,
      });
      const result = run(dir, [bin("check-coupling")]);
      expect({ code: result.code, diagnostics: lines(result.out, "check-coupling") }).toEqual({
        code,
        diagnostics,
      });
    },
  );

  test("checks only staged files with --staged", () => {
    const dir = repo({ "package.json": "{}", "src/old.ts": 'import "../../x";\n' });
    write(dir, { "src/new.ts": 'import "../../y";\n' });
    sh(dir, ["add", "src/new.ts"]);
    const found = lines(run(dir, [bin("check-coupling"), "--staged"]).out, "check-coupling");
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
    expect(lines(run(dir, [bin("check-coupling")]).out, "check-coupling")).toEqual(want);
    sh(dir, ["add", "catalog/Type.astro"]);
    expect(lines(run(dir, [bin("check-coupling"), "--staged"]).out, "check-coupling")).toEqual(
      want,
    );
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
    const found = lines(run(dir, [bin("check-coupling")]).out, "check-coupling");
    expect(found.sort()).toEqual([
      "[check-coupling] catalog/astro.config.ts: styles come from brand's exports, an engine's scaffolding.styles or this repository: import the stylesheet from @hackersandwizards/brand, move the CSS into this repository, or use the owning engine's composer. If the composer cannot supply the styles, declare the stylesheet in the engine's package.json scaffolding.styles and exports (@hackersandwizards/documents/doc.css)",
      "[check-coupling] src/admin.ts: styles come from brand's exports, an engine's scaffolding.styles or this repository: import the stylesheet from @hackersandwizards/brand, move the CSS into this repository, or use the owning engine's composer. If the composer cannot supply the styles, declare the stylesheet in the engine's package.json scaffolding.styles and exports (@hackersandwizards/admin/site.css)",
      `[check-coupling] src/deck-disk.ts: ${installed} (node_modules/@hackersandwizards/slides/styles/slides.css)`,
      "[check-coupling] src/deck-other.css: styles come from brand's exports, an engine's scaffolding.styles or this repository: import the stylesheet from @hackersandwizards/brand, move the CSS into this repository, or use the owning engine's composer. If the composer cannot supply the styles, declare the stylesheet in the engine's package.json scaffolding.styles and exports (@hackersandwizards/slides/styles/x.css)",
      `[check-coupling] src/deep.astro: ${installed} (node_modules/@hackersandwizards/brand/expert/expert.css)`,
      "[check-coupling] src/fonts.css: a stylesheet names a disk path only to a file @hackersandwizards/brand exports: import an exported path of @hackersandwizards/brand instead, or export the file in @hackersandwizards/brand's package.json exports and release a new tag; do not silence with scaffolding.allow (node_modules/@hackersandwizards/brand/fonts/inter.woff2)",
      "[check-coupling] src/fonts.css: not in the exports of @hackersandwizards/brand: import a subpath listed in @hackersandwizards/brand's package.json exports, or add this subpath to @hackersandwizards/brand's exports and release a new tag; do not silence with scaffolding.allow (@hackersandwizards/brand/tokens.css)",
      "[check-coupling] src/named.css: not in the exports of @hackersandwizards/brand: import a subpath listed in @hackersandwizards/brand's package.json exports, or add this subpath to @hackersandwizards/brand's exports and release a new tag; do not silence with scaffolding.allow (@hackersandwizards/brand/tokens/tokens.css)",
      "[check-coupling] src/shell.ts: the catalog shell's styles load only under catalog/: remove this @hackersandwizards/scaffolding CSS import from application code and use @hackersandwizards/brand exports or local styles instead, or move the file under catalog/ (@hackersandwizards/scaffolding/catalog/catalog.css)",
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
    expect(lines(run(dir, [bin("check-coupling")]).out, "check-coupling").sort()).toEqual([
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
    expect(lines(run(dir, [bin("check-coupling")]).out, "check-coupling").sort()).toEqual([
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
      lines(run(dir, [bin("check-coupling")], { HOME: home }).out, "check-coupling")
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
      lines(run(wt, [bin("check-coupling")], { HOME: home }).out, "check-coupling")
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
    expect(lines(run(dir, [bin("check-coupling")]).out, "check-coupling")).toEqual([
      `[check-coupling] src/b.ts: ${installed} (node_modules/@hackersandwizards/brand/x.svg)`,
    ]);
  });

  describe("coupling allow entries", () => {
    const allow = (entries: object[]) =>
      repo({
        "package.json": JSON.stringify({ scaffolding: { allow: entries } }),
        "src/a.ts": 'import "../../x";\n',
      });
    // Its text names the path it excuses, and package.json is not flagged for it.
    const reasoned = { check: "coupling", path: "src/*.ts", text: "../../x", reason: "test" };
    test("accepts a reasoned entry", () => {
      expect(run(allow([reasoned]), [bin("check-coupling")]).code).toBe(0);
    });
    test.each(["", true])("rejects reason %j", (reason) => {
      expect(run(allow([{ ...reasoned, reason }]), [bin("check-coupling")]).out).toContain(
        'allow entry without a reason: fix the underlying finding and remove this package.json scaffolding.allow entry, or add a non-empty "reason" explaining why the exception is required',
      );
    });
    test("rejects a stale entry", () => {
      const stale = allow([reasoned, { check: "coupling", path: "src/gone.ts", reason: "old" }]);
      expect(run(stale, [bin("check-coupling")]).out).toContain(
        "allow entry matches nothing: remove this stale entry (or unused path/text item) from package.json scaffolding.allow",
      );
    });
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

test.each([
  ["unset", undefined, 12_000],
  ["scaled", "7500", 18_000],
])("the test-timeout export gives a consumer its %s limit", (_, timeout, expected) => {
  const dir = repo({
    "test-limit.mjs": `import { limit } from "@hackersandwizards/scaffolding/test-timeout";
console.log(limit(12_000));\n`,
  });
  install(dir);
  const result = spawnSync(process.execPath, ["--no-env-file", "test-limit.mjs"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, SCAFFOLDING_TEST_TIMEOUT_MS: timeout },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(String(expected));
});

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
    lines(run(dir, [bin("check-structure"), ...args]).out, "check-structure").filter((l) =>
      l.includes("bin file"),
    );
  expect(binLines()).toEqual([
    "[check-structure] bin/x.ts: a bin file is stored executable (check-structure --fix) (100644)",
  ]);
  run(dir, [bin("check-structure"), "--fix"]);
  expect(binLines()).toEqual([]);
  expect(sh(dir, ["ls-files", "-s", "bin/x.ts"]).stdout.toString().startsWith("100755")).toBe(true);
  // --fix stages the mode alone, never an uncommitted edit.
  sh(dir, ["update-index", "--chmod=-x", "bin/x.ts"]);
  writeFileSync(join(dir, "bin/x.ts"), "#!/usr/bin/env bun\nedited;\n");
  run(dir, [bin("check-structure"), "--fix"]);
  expect(
    sh(dir, ["ls-files", "-s", "bin/x.ts"])
      .stdout.toString()
      .startsWith(`100755 ${sh(dir, ["rev-parse", "HEAD:bin/x.ts"]).stdout.toString().trim()} `),
  ).toBe(true);
});

test("check-structure: a hook with the skeleton's bytes but no executable bit fails, and --fix sets it", () => {
  const dir = repo({ "package.json": "{}" });
  run(dir, [bin("check-structure"), "--fix"]);
  sh(dir, ["add", "-A"]);
  const hookLines = () =>
    lines(run(dir, [bin("check-structure")]).out, "check-structure").filter((l) =>
      l.includes("a hook"),
    );
  expect(hookLines()).toEqual([]);
  chmodSync(join(dir, ".githooks/pre-commit"), 0o644);
  sh(dir, ["update-index", "--chmod=-x", ".githooks/post-merge"]);
  expect(hookLines()).toEqual([
    "[check-structure] .githooks/pre-commit: a hook is executable (check-structure --fix) (100755)",
    "[check-structure] .githooks/post-merge: a hook is executable (check-structure --fix) (100644)",
  ]);
  run(dir, [bin("check-structure"), "--fix"]);
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
  expect([...stored].filter(([, mode]) => mode !== "100755")).toEqual([]);
});

// BusyBox env refuses -S.
test.each(Object.values(ownPackage.bin))("%s starts through the portable shell header", (path) => {
  const bytes = readFileSync(join(import.meta.dirname, "..", path), "utf8");
  expect(bytes.split("\n").slice(0, 2)).toEqual([
    "#!/bin/sh",
    '// 2>/dev/null; exec bun --no-env-file "$0" "$@"',
  ]);
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
    .filter(Boolean)
    .filter((path) => !path.endsWith("/"));
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
  const made = run(parent, [bin("scaffold"), "demo", "--port", "4655"]);
  install(dir);
  write(dir, { "bun.lock": "" });
  sh(dir, ["config", "core.hooksPath", ".githooks"]);
  const hooksPath = (root: string) =>
    sh(root, ["config", "--local", "core.hooksPath"]).stdout.toString().trim();
  const copyScaffoldFixture = (
    name: string,
    config: Record<string, unknown>,
    files: Record<string, string> = {},
  ) => {
    const other = join(parent, name);
    cpSync(dir, other, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) => !path.endsWith("/node_modules"),
    });
    const pkg = scaffolded(other);
    Object.assign(pkg.scaffolding, config);
    const manifest = JSON.stringify(pkg, null, 2);
    write(other, { "package.json": manifest, ...files });
    return other;
  };
  const fixture = (
    name: string,
    config: Record<string, unknown>,
    files: Record<string, string> = {},
  ) => {
    const other = copyScaffoldFixture(name, config, files);
    install(other);
    return other;
  };

  test.each([
    {
      files: { "package.json": '{"name":"replacement"}\n' },
      manifest: '{"name":"replacement"}\n',
    },
  ])(
    "the scaffold fixture copy keeps the supplied manifest bytes and excludes dependencies",
    ({ files, manifest }) => {
      const copy = copyScaffoldFixture("manifest-override", { private: true }, files);
      expect(readFileSync(join(copy, "package.json"), "utf8")).toBe(manifest);
      expect(existsSync(join(copy, "node_modules"))).toBe(false);
    },
  );

  test("scaffold writes the manifest's name, Bun floor and prepare script", () => {
    expect(made.code).toBe(0);
    expect(scaffolded(dir)).toMatchObject({
      name: "demo",
      engines: { bun: ownPackage.engines.bun },
      scripts: { prepare: ownPackage.scripts.prepare },
    });
    expect(scaffolded(dir).scripts.fix).toBeUndefined();
  });

  test("scaffold fills every placeholder and renames every template", () => {
    const files = sh(dir, ["ls-files", "-z", "-co", "--exclude-standard"])
      .stdout.toString()
      .split("\0")
      .filter(Boolean);
    expect(files).not.toContainEqual(matchingText(/\.tmpl$/));
    const regularFiles = files.filter((file) => statSync(join(dir, file)).isFile());
    const unexpanded = regularFiles.filter((file) =>
      /\{\{\w+\}\}/.test(readFileSync(join(dir, file), "utf8")),
    );
    expect(unexpanded).toEqual([]);
  });

  test("a scaffolded repository passes check-structure", () => {
    expect(run(dir, [bin("check-structure")])).toEqual({ code: 0, out: "" });
  });

  test("the generic folder check passes tracked lookalikes and untracked generic folders", () => {
    const other = fixture(
      "generic-folder-control",
      {},
      {
        "src/corex/c.ts": "export {};\n",
        "utils/untracked.ts": "export {};\n",
      },
    );
    prepareGit(other, ["add", "--", "src/corex/c.ts"]);
    expect(run(other, [bin("check-structure")])).toEqual({ code: 0, out: "" });
  });

  test("tracked generic folders are reported once each with one guide", () => {
    const other = fixture(
      "generic-folder",
      {},
      {
        "src/utils/a.ts": "export {};\n",
        "src/utils/b.ts": "export {};\n",
        "src/Core/b.ts": "export {};\n",
        "src/corex/c.ts": "export {};\n",
        "utils/untracked.ts": "export {};\n",
      },
    );
    prepareGit(other, [
      "add",
      "--",
      "src/utils/a.ts",
      "src/utils/b.ts",
      "src/Core/b.ts",
      "src/corex/c.ts",
    ]);
    const red = run(other, [bin("check-structure")]);
    expect(red.code, red.out).toBe(1);
    expect(lines(red.out, "structure")).toEqual([
      "[structure] src/Core: folder named `Core`",
      "[structure] src/utils: folder named `utils`",
    ]);
    expectGuideAfter(red.out, "generic-folder", "folder named `utils`");
    expect(red.out).toMatch(/^\[check-structure\] 2 findings, \d+ ms$/m);
  });

  describe("commented Oxlint overrides", () => {
    const exercises = "tests/exercises/example.js";
    const comment = JSON.stringify(oxlintTemplate, null, 2).replace(
      /\n}$/,
      `,\n  "overrides": [
    // The exercises deliberately run with node --test.
    {
      "files": ["tests/exercises/**"],
      "plugins": ["vitest"],
      "rules": { "vitest/no-import-node-test": "off" }
    }
  ]\n}`,
    );
    let other: string;
    const tsconfig = JSON.stringify({
      extends: "@hackersandwizards/scaffolding/tsconfig/bun.json",
      compilerOptions: { allowJs: true, types: [] },
      include: ["catalog/**/*.ts", "src/**/*.ts", "tests/**/*.js"],
    });
    beforeAll(() => {
      other = fixture(
        "commented-oxlint",
        {},
        {
          ".oxlintrc.json": comment,
          "tsconfig.json": tsconfig,
          [exercises]: 'import "node:test";\n',
        },
      );
    });

    test.each([
      ["check-structure", []],
      ["check-names", []],
      ["check-layers", ["--check"]],
    ] as const)("%s accepts a commented Oxlint override", (command, args) => {
      const result = run(other, [bin(command), ...args]);
      expect(result.code, result.out).toBe(0);
    });

    const lint = (dir: string) => {
      symlinkSync(
        join(import.meta.dirname, "../node_modules/astro"),
        join(dir, "node_modules/astro"),
      );
      return spawnSync(
        process.execPath,
        ["--no-env-file", join(import.meta.dirname, "../lib/oxlint.ts")],
        {
          cwd: dir,
          encoding: "utf8",
        },
      );
    };

    test("Oxlint applies the one-rule override only in the exercise folder", () => {
      const accepted = lint(other);
      expect(accepted.status, accepted.stderr + accepted.stdout).toBe(0);

      const outside = fixture(
        "commented-oxlint-outside",
        {},
        {
          ".oxlintrc.json": comment,
          "tsconfig.json": tsconfig,
          [exercises]: 'import "node:test";\n',
          "tests/regular.js": 'import "node:test";\n',
        },
      );
      const refused = lint(outside);
      expect(refused.status, refused.stderr + refused.stdout).toBe(1);
      expect(refused.stdout).toContain("vitest(no-import-node-test)");
      expect(refused.stdout).toContain("tests/regular.js");
      expect(refused.stdout).not.toContain(exercises);
    });

    const disabledRule = '"vitest/no-import-node-test": "off"';
    const closingBrace = comment.indexOf("}", comment.indexOf(disabledRule));
    const missingSeverity = '"vitest/no-import-node-test":';
    test.each([
      [
        "missing severity",
        missingSeverity,
        `ValueExpected at position ${closingBrace - (disabledRule.length - missingSeverity.length)}`,
      ],
      [
        "trailing comma",
        `${disabledRule},`,
        `PropertyNameExpected at position ${closingBrace + 1}`,
      ],
    ])(
      "check-structure still reports malformed Oxlint configuration with %s",
      (name, rule, reason) => {
        const malformed = fixture(
          `malformed-commented-oxlint-${name}`,
          {},
          {
            ".oxlintrc.json": comment.replace(disabledRule, rule),
          },
        );
        const result = run(malformed, [bin("check-structure")]);
        expect(result.code).toBe(1);
        expect(lines(result.out, "check-structure")).toEqual([
          `[check-structure] .oxlintrc.json: ${reason}`,
        ]);
        expect(run(malformed, [bin("check-layers"), "--check"]).out).toContain(
          `.oxlintrc.json: cannot parse the config (${reason})`,
        );
      },
    );
  });

  test("scaffold sets the Claude defaults and omits the skills link without skills", () => {
    const settings = jsonObject(readFileSync(join(dir, ".claude/settings.json")));
    expect(settings.model).toBe("opus");
    expect(settings.effortLevel).toBe("medium");
    expect(settings).not.toHaveProperty("modelSettings");
    expect(lstatSync(join(dir, ".agents/skills"), { throwIfNoEntry: false })).toBeUndefined();
  });

  const agentPaths = [
    ".agents/plugins/repo/plugin.json",
    ".agents/plugins/repo/mcp_config.json",
    ".agents/hooks.json",
    ".codex/hooks.json",
  ];
  test("scaffold leaves no Pi config", () => {
    expect(lstatSync(join(dir, ".pi"), { throwIfNoEntry: false })).toBeUndefined();
  });

  test.each(agentPaths)("scaffold copies %s from the skeleton", (path) => {
    const starter = join(import.meta.dirname, "..", "template", path);
    expect(readFileSync(join(dir, path), "utf8"), path).toBe(readFileSync(starter, "utf8"));
  });

  describe("scaffolded agent config customizations", () => {
    const changed = ".agents/plugins/repo/mcp_config.json";
    const removed = agentPaths.filter((path) => path !== changed);
    let consumer: string;
    let content: string;
    beforeAll(() => {
      const settings = jsonObject(readFileSync(join(dir, changed)));
      const servers = settings.mcpServers;
      assert(isObject(servers), `${changed}: missing mcpServers`);
      content = JSON.stringify({ ...settings, mcpServers: { ...servers, own: { command: "x" } } });
      consumer = copyScaffoldFixture("agent-configs", {}, { [changed]: content });
      for (const path of removed) rmSync(join(consumer, path));
      install(consumer);
    });
    afterEach(() => {
      write(consumer, { [changed]: content });
      for (const path of removed) rmSync(join(consumer, path), { force: true });
    });

    test("accepts the consumer's agent configuration", () => {
      expect(run(consumer, [bin("check-structure")])).toEqual({ code: 0, out: "" });
    });
    test("does not rewrite or restore optional agent configs in fix mode", () => {
      expect(run(consumer, [bin("check-structure"), "--fix"])).toEqual({ code: 0, out: "" });
      expect(readFileSync(join(consumer, changed), "utf8"), changed).toBe(content);
      expect(removed.filter((path) => existsSync(join(consumer, path)))).toEqual([]);
    });
  });

  describe("the shared Oxlint configuration", () => {
    const name = ".oxlintrc.json";
    const config = {
      ...oxlintTemplate,
      rules: {
        "no-restricted-imports": [
          "error",
          { name: "blocked", message: "Use the public entry point." },
        ],
      },
    };
    let other: string;
    beforeAll(() => {
      other = copyScaffoldFixture("oxlint-structure", {});
      rmSync(join(other, name));
      install(other);
    });
    afterEach(() => rmSync(join(other, name), { force: true }));

    test("reports the missing configuration", () => {
      expect(run(other, [bin("check-structure")]).out).toContain(`${name}: missing`);
    });
    test("repairs the missing configuration", () => {
      expect(run(other, [bin("check-structure"), "--fix"]).code).toBe(0);
    });
    test("preserves a local layer policy in fix mode", () => {
      write(other, { [name]: JSON.stringify(config) });
      expect(run(other, [bin("check-structure"), "--fix"]).code).toBe(0);
      expect(jsonObject(readFileSync(join(other, name))).rules).toEqual(config.rules);
    });
    test.each([
      ["extends", { extends: [] }],
      ["options", { options: { typeAware: false } }],
      ["ignorePatterns", { ignorePatterns: [] }],
    ])("rejects a malformed %s policy", (field, broken) => {
      write(other, { [name]: JSON.stringify({ ...config, ...broken }) });
      const result = run(other, [bin("check-structure")]);
      expect(result.code).toBe(1);
      expect(result.out).toContain(`${name}: ${field}`);
    });
  });

  const messages = { message: "Put command code in bin." };
  const selectorMessages = [
    {
      root: { message: "Use an explicit error." },
      override: { message: "Use a breakpoint." },
      expected: [],
    },
    {
      root: { message: "  " },
      override: {},
      expected: [
        '[check-structure] .oxlintrc.json: rules.no-restricted-syntax needs a message saying what to write instead ("ThrowStatement")',
        '[check-structure] .oxlintrc.json: overrides[1].rules.no-restricted-syntax needs a message saying what to write instead ("DebuggerStatement")',
      ],
    },
  ] as const;
  const importMessages = [
    '[check-structure] .oxlintrc.json: rules.no-restricted-imports.paths[0] needs a message saying where code that needs this import belongs ("root-private")',
    '[check-structure] .oxlintrc.json: overrides[0].rules.no-restricted-imports.patterns[0] needs a message saying where code that needs this import belongs ("^private/")',
  ];
  function restrictionOptions(
    importMessage: Record<string, string>,
    syntax: object,
    override: object,
  ) {
    return JSON.stringify({
      ...oxlintTemplate,
      rules: {
        "no-restricted-imports": ["error", { paths: [{ name: "root-private", ...importMessage }] }],
        ...syntax,
      },
      overrides: [
        {
          files: ["src/**"],
          rules: {
            "no-restricted-imports": [
              "error",
              { patterns: [{ regex: "^private/", ...importMessage }] },
            ],
          },
        },
        { files: ["test/**"], rules: override },
      ],
    });
  }

  test.each([
    ["written", messages, { code: 0, out: "" }],
    ["missing", {}, { code: 1, out: containingText(importMessages[0]) }],
  ] as const)(
    "check-structure validates %s messages in Oxlint import restrictions",
    (name, message, expected) => {
      const other = fixture(
        `oxlint-restriction-${name}`,
        {},
        {
          ".oxlintrc.json": restrictionOptions(message, {}, {}),
        },
      );
      expect(run(other, [bin("check-structure")])).toEqual(expected);
    },
  );

  test("the restriction reader accepts explanations in root syntax rules and overrides", () => {
    const other = fixture(
      "oxlint-selector-written",
      {},
      {
        ".oxlintrc.json": restrictionOptions(
          messages,
          {
            "no-restricted-syntax": [
              "error",
              { selector: "ThrowStatement", ...selectorMessages[0].root },
            ],
          },
          {
            "no-restricted-syntax": [
              "error",
              { selector: "DebuggerStatement", ...selectorMessages[0].override },
            ],
          },
        ),
      },
    );
    // The pinned Oxlint rejects the syntax rule after this reader checks its explanations.
    const configuration = oxlintConfiguration(other);
    expect([...oxlintRestrictionFindings(configuration)]).toEqual([]);
  });

  test("check-structure reports missing explanations in root rules and overrides", () => {
    const blank = selectorMessages[1];
    const other = fixture(
      "oxlint-selector-missing",
      {},
      {
        ".oxlintrc.json": restrictionOptions(
          {},
          { "no-restricted-syntax": ["error", { selector: "ThrowStatement", ...blank.root }] },
          {
            "no-restricted-syntax": ["error", { selector: "DebuggerStatement", ...blank.override }],
          },
        ),
      },
    );
    const result = run(other, [bin("check-structure")]);
    expect(result.code).toBe(1);
    expect(lines(result.out, "check-structure")).toEqual([
      importMessages[0],
      blank.expected[0],
      importMessages[1],
      blank.expected[1],
    ]);
  });

  const pluginAliases = [
    "typescript",
    "@typescript-eslint",
    "typescript-eslint",
    "typescript_eslint",
  ];
  test.each(
    pluginAliases.flatMap((plugin) => {
      const rule = `${plugin}/no-restricted-imports`;
      const rules = { [rule]: ["error", { paths: [{ name: "fs" }] }] };
      return [
        { plugin, location: "rules", config: { rules } },
        {
          plugin,
          location: "overrides[0].rules",
          config: { overrides: [{ files: ["src/**"], rules }] },
        },
      ];
    }),
  )(
    "Oxlint $plugin import restrictions need messages at $location",
    ({ plugin, location, config }) => {
      const other = fixture(
        `oxlint-imports-${plugin}-${location}`,
        {},
        { ".oxlintrc.json": JSON.stringify({ ...oxlintTemplate, ...config }) },
      );
      const result = run(other, [bin("check-structure")]);
      expect(result.code).toBe(1);
      expect(lines(result.out, "check-structure")).toEqual([
        `[check-structure] .oxlintrc.json: ${location}.${plugin}/no-restricted-imports.paths[0] needs a message saying where code that needs this import belongs ("fs")`,
      ]);
    },
  );

  test.each([
    {
      name: "bare-string",
      option: "fs",
      location: "",
      guidance:
        'replace the string with { "name": ..., "message": ... } and say where code that needs this import belongs',
    },
    {
      name: "bare-object",
      option: { name: "fs" },
      location: "",
      guidance: "needs a message saying where code that needs this import belongs",
    },
    {
      name: "blank-message",
      option: { name: "fs", message: "   " },
      location: "",
      guidance: "needs a message saying where code that needs this import belongs",
    },
    {
      name: "path-string",
      option: { paths: ["fs"] },
      location: ".paths[0]",
      guidance:
        'replace the string with { "name": ..., "message": ... } and say where code that needs this import belongs',
    },
    {
      name: "pattern-string",
      option: { patterns: ["fs"] },
      location: ".patterns[0]",
      guidance:
        'replace the string with { "group": [...], "message": ... } and say where code that needs this import belongs',
    },
  ])(
    "Oxlint import restriction $name tells the reader how to add a message",
    ({ name, option, location, guidance }) => {
      const file = ".oxlintrc.json";
      const config = { ...oxlintTemplate, rules: { "no-restricted-imports": ["error", option] } };
      const other = fixture(`oxlint-imports-${name}`, {}, { [file]: JSON.stringify(config) });
      const result = run(other, [bin("check-structure")]);
      expect(result.code).toBe(1);
      expect(lines(result.out, "check-structure")).toEqual([
        `[check-structure] ${file}: rules.no-restricted-imports${location} ${guidance} ("fs")`,
      ]);
    },
  );

  test.each(["off", 0, "allow"])(
    "Oxlint disabled import restriction (%s) needs no message",
    (severity) => {
      const file = ".oxlintrc.json";
      const config = {
        ...oxlintTemplate,
        rules: { "no-restricted-imports": [severity, { paths: [{ name: "fs" }] }] },
      };
      const other = fixture(`oxlint-disabled-${severity}`, {}, { [file]: JSON.stringify(config) });
      expect(run(other, [bin("check-structure")])).toEqual({ code: 0, out: "" });
    },
  );

  test("Oxlint bare string selectors need a message", () => {
    const file = ".oxlintrc.json";
    const config = {
      ...oxlintTemplate,
      rules: { "no-restricted-syntax": ["error", "WithStatement"] },
    };
    const other = fixture("oxlint-syntax-string", {}, { [file]: JSON.stringify(config) });
    const result = run(other, [bin("check-structure")]);
    expect(result.code).toBe(1);
    expect(lines(result.out, "check-structure")).toEqual([
      '[check-structure] .oxlintrc.json: rules.no-restricted-syntax replace the string with { "selector": ..., "message": ... } and say what to write instead ("WithStatement")',
    ]);
  });

  describe("the effective lint presets are disjoint", () => {
    const config = 'import base from "@hackersandwizards/scaffolding/eslint/astro";\n';
    const eslint = "eslint.config.js";
    const oxlint = ".oxlintrc.json";
    let other: string;
    beforeAll(() => {
      other = fixture(
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
    }, limit(10_000));
    afterEach(() =>
      write(other, {
        [eslint]: config + "export default base;\n",
        [oxlint]: JSON.stringify(oxlintTemplate),
      }),
    );
    test(
      "shared presets pass without a local rule",
      () => {
        expect(run(other, [bin("check-structure")])).toEqual({ code: 0, out: "" });
      },
      limit(10_000),
    );
    test(
      "rejects local ESLint overlaps in JS, TS, tests and Astro client scripts",
      () => {
        write(other, {
          [eslint]:
            config +
            `export default [...base,
        { files: ["src/probe.js", "src/*.astro/*.ts"], rules: { "no-debugger": "warn" } },
        { files: ["src/probe.ts"], rules: { "@typescript-eslint/no-floating-promises": "error" } },
        { files: ["src/probe.test.ts"], rules: { "@typescript-eslint/no-unused-vars": "error" } },
      ];\n`,
        });
        const localEslint = run(other, [bin("check-structure")]);
        expect(localEslint.code).toBe(1);
        expect(lines(localEslint.out, "check-structure")).toEqual([
          matchingText(
            /src\/Probe\.astro\/\S+\.ts: ESLint rule no-debugger overlaps Oxlint rule no-debugger.*\(Astro client script\)/,
          ),
          containingText("src/probe.js: ESLint rule no-debugger overlaps Oxlint rule no-debugger"),
          containingText(
            "src/probe.test.ts: ESLint rule @typescript-eslint/no-unused-vars overlaps Oxlint rule no-unused-vars",
          ),
          containingText(
            "src/probe.ts: ESLint rule @typescript-eslint/no-floating-promises overlaps Oxlint rule typescript/no-floating-promises",
          ),
        ]);
      },
      limit(10_000),
    );

    test(
      "rejects local ESLint overlaps in Astro frontmatter",
      () => {
        write(other, {
          [eslint]:
            config +
            'export default [...base, { files: ["src/Probe.astro/*_frontmatter.tsx"], rules: { "no-debugger": "error" } }];\n',
        });
        const frontmatterOverlap = run(other, [bin("check-structure")]);
        expect(frontmatterOverlap.code).toBe(1);
        expect(lines(frontmatterOverlap.out, "check-structure")).toEqual([
          matchingText(
            /src\/Probe\.astro\/\d+_frontmatter\.tsx: ESLint rule no-debugger overlaps Oxlint rule no-debugger.*\(Astro frontmatter\)/,
          ),
        ]);
      },
      limit(10_000),
    );

    test(
      "rejects an Oxlint overlap in Astro template and script lint",
      () => {
        write(other, {
          [oxlint]: JSON.stringify({
            ...oxlintTemplate,
            overrides: [{ files: ["src/*.astro"], rules: { "eslint/no-undef": "warn" } }],
          }),
        });
        const localOxlint = run(other, [bin("check-structure")]);
        expect(localOxlint.code).toBe(1);
        expect(lines(localOxlint.out, "check-structure")).toEqual([
          containingText("src/Probe.astro: ESLint rule no-undef overlaps Oxlint rule no-undef"),
          matchingText(
            /src\/Probe\.astro\/\S+\.ts: ESLint rule no-undef overlaps Oxlint rule no-undef/,
          ),
        ]);
      },
      limit(10_000),
    );
  });

  test("a full repository has its catalog, brand and admin on their newest tags", () => {
    const pkg = scaffolded(dir);
    expect(pkg.devDependencies).toMatchObject({
      "@hackersandwizards/brand": "git+https://github.com/hackersandwizards/brand.git#v0.10.0",
      "@hackersandwizards/admin": "git+https://github.com/hackersandwizards/admin.git#v0.10.0",
      "eslint-plugin-astro": ownPackage.devDependencies["eslint-plugin-astro"],
    });
  });

  test("a full scaffold wires the catalog build, preview and gate steps", () => {
    const pkg = scaffolded(dir);
    expect(pkg.scaffolding.skip).toEqual({
      test: "new repository: no tests yet",
      elements: "the starter catalog declares no brand element pages",
    });
    expect(pkg.scripts).toMatchObject({
      build: "check-lock bun --bun astro build --root catalog",
      preview: PREVIEW,
    });
    expect(pkg.scripts["check:retired"]).toBeUndefined();
    expect(pkg.scaffolding.brand).toEqual({ retired: ["dist"] });
  });

  test("a full scaffold configures the catalog and Astro lint", () => {
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
  });

  test("a full scaffold pins the Pages workflow and leaves the work item folder empty", () => {
    expect(readFileSync(join(dir, ".github/workflows/pages.yml"), "utf8")).toContain(
      `uses: hackersandwizards/scaffolding/.github/workflows/pages.yml@${ownHead} # v${ownVersion}\n`,
    );
    // No placeholder item: the hub would list it as the repository's open goal.
    expect(readdirSync(join(dir, "docs/agent-work"))).toEqual([".gitkeep"]);
  });

  test("a full scaffold covers its catalog in TypeScript and is already formatted", () => {
    expect(readFileSync(join(dir, "tsconfig.json"), "utf8")).toContain('"catalog/**/*.ts"]');
    const prettier = join(import.meta.dirname, "..", "node_modules", ".bin", "prettier");
    const formatted = spawnSync(prettier, ["--check", "."], { cwd: dir, encoding: "utf8" });
    expect(`${formatted.stdout}${formatted.stderr}`).toContain("All matched files use Prettier");
    expect(formatted.status).toBe(0);
  });

  test("--name keeps the scope out of the Pages path and title", () => {
    const at = temp();
    expect(run(at, [bin("scaffold"), "scoped", "--name", "@acme/scoped"]).code).toBe(0);
    const config = readFileSync(join(at, "scoped/catalog/astro.config.ts"), "utf8");
    expect(config).toContain('base: "/scoped"');
    expect(config).toContain('product: "scoped"');
    expect(readFileSync(join(at, "scoped/README.md"), "utf8").startsWith("# scoped\n")).toBe(true);
    expect(readPackage(join(at, "scoped")).name).toBe("@acme/scoped");
  });

  test("scaffold reports the remaining steps for a repository with a remote catalog", () => {
    const at = temp();
    const next = [
      "Next, in the terminal: cd inner && bun install && bun run check",
      "[scaffold] Then by hand:",
      "[scaffold]   1. add inner to the hub's sync list",
      "[scaffold]   2. create hackersandwizards/inner on GitHub and push to it\n",
    ].join("\n");
    expect(run(at, [bin("scaffold"), "inner", "--catalog-in", "x"]).out.endsWith(next)).toBe(true);
  });

  test.each(['a"b', "Upper"])("--name refuses %s before writing a repository", (name) => {
    const at = temp();
    const bad = run(at, [bin("scaffold"), "bad", "--name", name]);
    expect(bad.out).toContain("is no npm package name");
    expect(existsSync(join(at, "bad"))).toBe(false);
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

  describe("--catalog-in and --admin-in", () => {
    const minimal = join(parent, "minimal");
    beforeAll(() => {
      const r = run(
        parent,
        [bin("scaffold"), "minimal", "--catalog-in", "acme-private", "--admin-in", "acme-private"],
        {
          SCAFFOLDING_GIT_BASE: "/nonexistent/",
        },
      );
      requireFixtureSuccess(
        "scaffold minimal --catalog-in acme-private --admin-in acme-private",
        r.code,
        r.out,
      );
      install(minimal);
      write(minimal, { "bun.lock": "" });
      prepareGit(minimal, ["config", "core.hooksPath", ".githooks"]);
    });
    test("name the remote catalog and admin in the gate skips", () => {
      const pkg = scaffolded(minimal);
      const ownPackages = Object.keys(pkg.devDependencies).filter((d) =>
        d.startsWith("@hackersandwizards/"),
      );
      expect(ownPackages).toEqual(["@hackersandwizards/scaffolding"]);
      expect(pkg.scripts["check:retired"]).toBeUndefined();
      expect({ check: pkg.scaffolding.check, skip: pkg.scaffolding.skip }).toEqual({
        check: [],
        skip: {
          test: "new repository: no tests yet",
          catalog: "the catalog lives in acme-private",
          styles: "the catalog lives in acme-private",
          admin: "the admin area lives in acme-private",
        },
      });
    });
    test.each(["catalog", ".github", "stylelint.config.js"])(
      "omits %s for a remote catalog",
      (path) => {
        expect(readdirSync(minimal)).not.toContain(path);
      },
    );
    test("leaves work items empty and passes structure", () => {
      expect(readdirSync(join(minimal, "docs/agent-work"))).toEqual([".gitkeep"]);
      expect(run(minimal, [bin("check-structure")]).code).toBe(0);
    });
  });

  test("a remote without a version tag fails scaffold", () => {
    const r = run(parent, [bin("scaffold"), "untagged"], {
      SCAFFOLDING_GIT_BASE: remotes(["latest"]),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("no v<version> tag read from");
  });

  describe("the owned Pages workflow", () => {
    const workflow = ".github/workflows/pages.yml";
    const path = join(dir, workflow);
    let original: string;
    beforeAll(() => {
      original = readFileSync(path, "utf8");
    });
    const edit = () =>
      write(dir, { [workflow]: original.replace(`@${ownHead}`, `@v${ownVersion}`) });

    test("reports an edited workflow", () => {
      edit();
      try {
        expect(lines(run(dir, [bin("check-structure")]).out, "check-structure")).toEqual([
          "[check-structure] .github/workflows/pages.yml: differs from the skeleton (check-structure --fix)",
        ]);
      } finally {
        writeFileSync(path, original);
      }
    });

    test("--fix writes this version and the result passes", () => {
      edit();
      try {
        run(dir, [bin("check-structure"), "--fix"]);
        expect(readFileSync(path, "utf8")).toBe(original);
        expect(run(dir, [bin("check-structure")]).code).toBe(0);
      } finally {
        writeFileSync(path, original);
      }
    });

    test("passes when the workflow is absent", () => {
      rmSync(path);
      try {
        expect(run(dir, [bin("check-structure")]).code).toBe(0);
      } finally {
        writeFileSync(path, original);
      }
    });
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
    run(other, [bin("check-structure"), "--fix"]);
    expect(readFileSync(join(other, path), "utf8")).toBe("custom\n");
    expect(run(other, [bin("check-structure")]).code).toBe(0);
  });

  test("LICENSE is required where the repository is public; a private one may have none", () => {
    const missing = (config: Record<string, unknown>, name: string) => {
      const other = copyScaffoldFixture(name, config);
      rmSync(join(other, "LICENSE"));
      install(other);
      return lines(run(other, [bin("check-structure")]).out, "check-structure").filter((l) =>
        l.includes("LICENSE"),
      );
    };
    expect(missing({}, "public-no-license")).toEqual([
      "[check-structure] LICENSE: missing: create this required skeleton file (see @hackersandwizards/scaffolding skeleton.json), or if this is a private repository and LICENSE is missing, set scaffolding.private: true in package.json",
    ]);
    expect(missing({ private: true }, "private-no-license")).toEqual([]);
  });

  const skillsLinkFinding =
    "[check-structure] .agents/skills: must be a symlink to ../.claude/skills: if missing, run check-structure --fix; if a regular file or wrong target exists there, remove it and create the symlink with `ln -s ../.claude/skills .agents/skills`";

  test("the .agents/skills link is optional when .claude/skills is absent", () => {
    const none = fixture("no-skills", {});
    expect(lines(run(none, [bin("check-structure")]).out, "check-structure")).toEqual([]);
  });

  test("check-structure reports and repairs a missing .agents/skills link", () => {
    const skills = fixture("skills", {}, { ".claude/skills/a/SKILL.md": "x\n" });
    expect(lines(run(skills, [bin("check-structure")]).out, "check-structure")).toEqual([
      skillsLinkFinding,
    ]);
    run(skills, [bin("check-structure"), "--fix"]);
    expect(run(skills, [bin("check-structure")]).code).toBe(0);
  });

  test("a wrong .agents/skills link is reported even when .claude/skills is absent", () => {
    const wrong = fixture("wrong-link", {}, { "keep/x": "x\n" });
    symlinkSync("../keep", join(wrong, ".agents/skills"));
    expect(lines(run(wrong, [bin("check-structure")]).out, "check-structure")).toEqual([
      skillsLinkFinding,
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
    expect(lines(run(other, [bin("check-structure")]).out, "check-structure")).toEqual([
      "[check-structure] .mcp.json: differs from the skeleton (check-structure --fix) (mcpServers.chrome-devtools)",
      "[check-structure] .claude/settings.json: differs from the skeleton (check-structure --fix) (hooks.SessionStart)",
    ]);
    run(other, [bin("check-structure"), "--fix"]);
    expect(run(other, [bin("check-structure")]).code).toBe(0);
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
  });

  test("--fix reports malformed parents of skeleton MCP and SessionStart blocks", () => {
    const other = fixture(
      "malformed-entries",
      {},
      {
        ".claude/settings.json": '{ "hooks": "x" }\n',
        ".mcp.json": "null\n",
      },
    );
    expect(lines(run(other, [bin("check-structure"), "--fix"]).out, "check-structure")).toEqual([
      "[check-structure] .mcp.json: mcpServers.chrome-devtools sits in no JSON object: repair the JSON syntax in this file so every parent of mcpServers.chrome-devtools is an object ({}), then run check-structure --fix",
      "[check-structure] .claude/settings.json: hooks.SessionStart sits in no JSON object: repair the JSON syntax in this file so every parent of hooks.SessionStart is an object ({}), then run check-structure --fix",
    ]);
  });

  test("the retired install guard goes red", () => {
    const guard = "scripts/repo/only-bun.cjs";
    const other = fixture("only-bun", {}, { [guard]: "\n" });
    expect(lines(run(other, [bin("check-structure")]).out, "check-structure")).toEqual([
      `[check-structure] ${guard}: not allowed by the skeleton: delete this retired file and move any needed configuration into the canonical file (.oxlintrc.json, eslint.config.js, prettier.config.js, vitest.config.ts, or bun.lock)`,
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
      const other = copyScaffoldFixture(
        "skip-public",
        { skip },
        {
          ".githooks/pre-commit": "#!/bin/sh\ncustom\n",
          "bin/x.ts": "export {};\n",
          ".claude/skills/a/SKILL.md": "x\n",
        },
      );
      for (const path of [
        ".editorconfig",
        ".npmrc",
        "bunfig.toml",
        ".githooks/commit-msg",
        ".githooks/post-merge",
      ])
        rmSync(join(other, path));
      install(other);
      const pkg = scaffolded(other);
      write(other, { "package.json": JSON.stringify({ ...pkg, bin: { x: "bin/x.ts" } }) });
      sh(other, ["config", "--unset", "core.hooksPath"]);
      sh(other, ["add", "bin/x.ts"]);
      const before = state(other);
      expect(run(other, [bin("check-structure")]).code).toBe(1);
      const fixed = run(other, [bin("check-structure"), "--fix"]);
      expect(fixed.code).toBe(0);
      expect(fixed.out).toContain("--fix writes nothing: scaffolding.skip.structure");
      expect(state(other)).toEqual(before);
    });

    test.each([
      ["with a reason", "custom skeleton files", "reason"],
      ["without a reason", "", "blank"],
    ])(
      "skip.structure %s keeps a private repository's commit-msg and older hook",
      (_, reason, suffix) => {
        const other = copyScaffoldFixture(
          `skip-private-${suffix}`,
          { skip: { structure: reason }, private: true },
          {
            ".githooks/post-checkout": "#!/bin/sh\nolder\n",
            ".claude/skills/a/SKILL.md": "x\n",
          },
        );
        rmSync(join(other, "bunfig.toml"));
        install(other);
        const before = state(other);
        expect(run(other, [bin("check-structure"), "--fix"]).code).toBe(0);
        expect(state(other)).toEqual(before);
      },
    );

    test.each([
      ["one path", ".githooks/pre-push", true],
      ["a glob", ".githooks/pre-p*", true],
      ["a list", [".githooks/pre-push", "bunfig.toml"], false],
    ] as const)(
      "an allow entry naming %s keeps the file and --fix still repairs the rest",
      (shape, path, hasBunfig) => {
        const other = copyScaffoldFixture(
          `allow-${shape.replace(" ", "-")}`,
          { private: true, allow: [{ check: "structure", path, reason: "own hook" }] },
          {
            ".githooks/pre-push": "#!/bin/sh\ncustom\n",
            ".editorconfig": "root = true\n",
          },
        );
        rmSync(join(other, "bunfig.toml"));
        install(other);
        run(other, [bin("check-structure"), "--fix"]);
        expect(readFileSync(join(other, ".githooks/pre-push"), "utf8")).toBe("#!/bin/sh\ncustom\n");
        expect(existsSync(join(other, "bunfig.toml"))).toBe(hasBunfig);
        expect(readFileSync(join(other, ".editorconfig"), "utf8")).not.toBe("root = true\n");
        expect(existsSync(join(other, ".githooks/commit-msg"))).toBe(false);
      },
    );
  });

  describe("editorconfig drift", () => {
    const file = join(dir, ".editorconfig");
    let original: string;
    beforeEach(() => {
      original = readFileSync(file, "utf8");
      writeFileSync(file, "root = true\n");
    });
    afterEach(() => writeFileSync(file, original));
    test("reports the drift", () => {
      expect(run(dir, [bin("check-structure")]).out).toContain(
        ".editorconfig: differs from the skeleton",
      );
    });
    test("repairs the drift with --fix", () => {
      const fix = run(dir, [bin("check-structure"), "--fix"]);
      expect(fix.code, fix.out).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(original);
      expect(run(dir, [bin("check-structure")]).code).toBe(0);
    });
  });

  test("a forbidden file, a wrong width and the hooks path go red", () => {
    const other = join(parent, "other");
    run(parent, [bin("scaffold"), "other"]);
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
    const out = run(other, [bin("check-structure")]).out;
    expect(out).toContain(
      "eslint.config.mjs: not allowed by the skeleton: delete this retired file and move any needed configuration into the canonical file (.oxlintrc.json, eslint.config.js, prettier.config.js, vitest.config.ts, or bun.lock)",
    );
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
    const config = { "stryker.config.mjs": "export default {};\n" };
    test.each([
      { name: "allows no mutation script without Stryker", files: {}, expected: green },
      {
        name: "requires the wrapper with the Stryker dependency",
        dependencies: { "@stryker-mutator/core": "10.1.1" },
        files: {},
        expected: red,
      },
      {
        name: "rejects running Stryker directly",
        mutation: "stryker run",
        files: config,
        expected: red,
      },
      {
        name: "rejects echoing the wrapper",
        mutation: "echo scaffolding-mutation",
        files: config,
        expected: red,
      },
      {
        name: "rejects naming the wrapper in an environment variable",
        mutation: "FLAG='scaffolding-mutation' bun run stryker run",
        files: config,
        expected: red,
      },
      {
        name: "accepts the wrapper",
        mutation: "scaffolding-mutation",
        files: config,
        expected: green,
      },
      {
        name: "accepts the wrapper with an environment variable and Bun flags",
        mutation: "BUN_OPTIONS='--preload vitest/node' bun --bun scaffolding-mutation",
        files: config,
        expected: green,
      },
    ])("$name", ({ name, dependencies, mutation, files, expected }) => {
      const other = fixture(`mutation-wrapper ${name}`, {}, files);
      const pkg = scaffolded(other);
      write(other, {
        "package.json": JSON.stringify({
          ...pkg,
          devDependencies: { ...pkg.devDependencies, ...dependencies },
          scripts: { ...pkg.scripts, mutation },
        }),
      });
      const { code, out } = run(other, [bin("check-structure")]);
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
    expect(run(other, [bin("check-structure")])).toEqual({ code: 0, out: "" });
    const config = readFileSync(join(other, path), "utf8");
    write(other, { [path]: config.replace("lib/deck-edit.ts", "lib/deck-edit.ts:15-217") });
    const result = run(other, [bin("check-structure")]);
    expect(result.code).toBe(1);
    expect(lines(result.out, "check-structure")).toEqual([
      "[check-structure] stryker.config.mjs: mutate must select whole files, without line ranges: remove the :start-end suffix from the mutate entry in the Stryker config so the entire file is mutated (lib/deck-edit.ts:15-217)",
    ]);
  });

  describe("check-structure requires test commands to pass on the gate timeout", () => {
    let other: string;
    let pkg: ReturnType<typeof scaffolded>;
    beforeAll(() => {
      other = join(parent, "timeout");
      const setup = run(parent, [
        bin("scaffold"),
        "timeout",
        "--catalog-in",
        "x",
        "--admin-in",
        "x",
      ]);
      requireFixtureSuccess("scaffold timeout --catalog-in x --admin-in x", setup.code, setup.out);
      install(other);
      write(other, { "bun.lock": "" });
      prepareGit(other, ["config", "core.hooksPath", ".githooks"]);
      pkg = scaffolded(other);
      pkg.scaffolding.skip.lint = "fixture checks the test runner timeout";
    });
    const inherited = "bun test --timeout ${SCAFFOLDING_TEST_TIMEOUT_MS:-5000}";
    const red = (command: string) => [
      "[check-structure] package.json: scaffolding.test passes no SCAFFOLDING_TEST_TIMEOUT_MS on: bun test --timeout ${SCAFFOLDING_TEST_TIMEOUT_MS:-5000}, vitest's testTimeout read from it, or the shared Vitest base (" +
        command +
        ")",
    ];
    const vitestCases = [
      [
        "direct timeout",
        "export default { test: { testTimeout: Number(process.env.SCAFFOLDING_TEST_TIMEOUT_MS ?? 5000) } };\n",
        [],
      ],
      ["shared re-export", 'export { default } from "@hackersandwizards/scaffolding/vitest";', []],
      [
        "base export",
        'import base from "@hackersandwizards/scaffolding/vitest";\nexport default base;',
        [],
      ],
      [
        "merged base",
        'import { mergeConfig } from "vitest/config";\nimport base from "@hackersandwizards/scaffolding/vitest";\nexport default mergeConfig(base, { test: { include: ["test/*.ts"] } });',
        [],
      ],
      [
        "comment",
        '// export { default } from "@hackersandwizards/scaffolding/vitest";',
        red("vitest run"),
      ],
      [
        "string",
        "const mention = 'export { default } from \"@hackersandwizards/scaffolding/vitest\";';\nexport default {};",
        red("vitest run"),
      ],
      [
        "unused import",
        'import base from "@hackersandwizards/scaffolding/vitest";\nexport default {};',
        red("vitest run"),
      ],
    ] as const;
    const inputs = [
      {
        name: "Bun test script without time limit",
        configuration: { test: "test" },
        scripts: { test: "bun test" },
        files: {},
        expected: red("test"),
      },
      {
        name: "Bun test script with time limit",
        configuration: { test: "test" },
        scripts: { test: inherited },
        files: {},
        expected: [],
      },
      {
        name: "direct Bun test invocation overrides same named script",
        configuration: { test: "bun test -t toString" },
        scripts: { test: inherited },
        files: {},
        expected: red("bun test -t toString"),
      },
      {
        name: "Bun test script invokes another script",
        configuration: { test: "bun run test" },
        scripts: { test: "bun run test:unit", "test:unit": inherited },
        files: {},
        expected: [],
      },
      {
        name: "Vitest config is absent",
        configuration: { test: "vitest run" },
        scripts: {},
        files: {},
        expected: red("vitest run"),
      },
      ...vitestCases.map(([name, config, expected]) => ({
        name,
        configuration: { test: "vitest run" },
        scripts: {},
        files: { "vitest.config.ts": config },
        expected,
      })),
    ];
    test.each(inputs)("$name", ({ configuration, scripts, files, expected }) => {
      rmSync(join(other, "vitest.config.ts"), { force: true });
      write(other, {
        "package.json": JSON.stringify({
          ...pkg,
          scripts: { ...pkg.scripts, ...scripts },
          scaffolding: {
            ...pkg.scaffolding,
            skip: { ...pkg.scaffolding.skip, test: undefined },
            ...configuration,
          },
        }),
        ...files,
      });
      expect(lines(run(other, [bin("check-structure")]).out, "check-structure")).toEqual(expected);
    });

    test("skipping tests requires no configured test command", () => {
      rmSync(join(other, "vitest.config.ts"), { force: true });
      write(other, { "package.json": JSON.stringify(pkg) });
      expect(lines(run(other, [bin("check-structure")]).out, "check-structure")).toEqual([]);
    });
  });

  describe("a repository with a catalog surface", () => {
    let other: string;
    let broken: string;
    let valid: string;
    const source = "catalog/astro.config.ts";
    const alternate = ["talks/astro.config.ts", "talks/astro.config.js", "talks/astro.config.mts"];
    const preset =
      'import { catalog } from "@hackersandwizards/scaffolding/catalog";\nexport default { integrations: [catalog] };\n';
    beforeAll(() => {
      other = join(parent, "surface");
      const setup = run(parent, [
        bin("scaffold"),
        "surface",
        "--catalog-in",
        "x",
        "--admin-in",
        "x",
      ]);
      requireFixtureSuccess("scaffold surface", setup.code, setup.out);
      install(other);
      write(other, { "bun.lock": "" });
      prepareGit(other, ["config", "core.hooksPath", ".githooks"]);
      const pkg = scaffolded(other);
      // false gives no reason, as a missing skip.catalog does.
      pkg.scaffolding.skip.catalog = false;
      pkg.scaffolding.check = ["brand-colours", ["check:markers", "lint"]];
      pkg.scripts["check:markers"] = "true";
      broken = JSON.stringify(pkg);
      pkg.scaffolding.check = [["check:markers"]];
      Object.assign(pkg.scripts, { dev: "x", catalog: "x", build: "x" });
      valid = JSON.stringify(pkg);
    }, limit(10_000));
    afterEach(() => {
      for (const file of [source, ...alternate]) rmSync(join(other, file), { force: true });
    });

    test(
      "reports missing scripts, invalid local steps and an absent preset",
      () => {
        write(other, { "package.json": broken });
        const found = lines(run(other, [bin("check-structure")]).out, "check-structure");
        expect(found.sort()).toEqual([
          '[check-structure] catalog/astro.config.ts: the Astro config must use the catalog preset from @hackersandwizards/scaffolding/catalog: import { catalog } from "@hackersandwizards/scaffolding/catalog" and add catalog(...) to integrations in the Astro config, or set scaffolding.skip.catalog with a reason in package.json if this repo has no UI catalog',
          "[check-structure] package.json: a step of scaffolding.check is a script named check:<what>: rename the step and its package.json script to check:<what>, or use a built-in placed step (colours, copies, retired, elements, links, browser-test) (brand-colours)",
          "[check-structure] package.json: a step of scaffolding.check is a script named check:<what>: rename the step and its package.json script to check:<what>, or use a built-in placed step (colours, copies, retired, elements, links, browser-test) (lint)",
          '[check-structure] package.json: script build missing: add "build" under "scripts" in package.json (or if this is a catalog script and the repo has no catalog, set scaffolding.skip.catalog with a reason) (build)',
          '[check-structure] package.json: script catalog missing: add "catalog" under "scripts" in package.json (or if this is a catalog script and the repo has no catalog, set scaffolding.skip.catalog with a reason) (catalog)',
          '[check-structure] package.json: script dev missing: add "dev" under "scripts" in package.json (or if this is a catalog script and the repo has no catalog, set scaffolding.skip.catalog with a reason) (dev)',
        ]);
      },
      limit(10_000),
    );

    test(
      "rejects a comment that names the preset without loading it",
      () => {
        write(other, {
          "package.json": valid,
          [source]: "// @hackersandwizards/scaffolding/catalog\n",
        });
        expect(lines(run(other, [bin("check-structure")]).out, "check-structure")).toEqual([
          '[check-structure] catalog/astro.config.ts: the Astro config must use the catalog preset from @hackersandwizards/scaffolding/catalog: import { catalog } from "@hackersandwizards/scaffolding/catalog" and add catalog(...) to integrations in the Astro config, or set scaffolding.skip.catalog with a reason in package.json if this repo has no UI catalog',
        ]);
      },
      limit(10_000),
    );

    test.each([source, ...alternate])(
      "accepts the preset in %s without a stories folder",
      (path) => {
        write(other, { "package.json": valid, [path]: preset });
        expect(run(other, [bin("check-structure")])).toEqual({ code: 0, out: "" });
      },
      limit(10_000),
    );
  });

  test("a private repository keeps no commit-msg hook", () => {
    const other = fixture("private", { private: true });
    expect(lines(run(other, [bin("check-structure")]).out, "check-structure").sort()).toEqual([
      "[check-structure] .githooks/commit-msg: not kept in a private repository (check-structure --fix)",
    ]);
    run(other, [bin("check-structure"), "--fix"]);
    expect(run(other, [bin("check-structure")]).code).toBe(0);
    expect(existsSync(join(other, ".githooks/commit-msg"))).toBe(false);
  });

  test("a repository without package.json is reported, not a crash", () => {
    const r = run(repo({ "a.md": "a\n" }), [bin("check-structure")]);
    expect(r.code).toBe(1);
    expect(lines(r.out, "check-structure")).toContain(
      "[check-structure] package.json: missing: create this required skeleton file (see @hackersandwizards/scaffolding skeleton.json)",
    );
  });

  test("a scaffolded repository passes check-coupling but for the pins bun install fetches", () => {
    expect(lines(run(dir, [bin("check-coupling")]).out, "check-coupling")).toEqual([
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
  writeFileSync(list, run(temp(), [bin("check-confidential"), "build", names]).out);
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
      run(dir, [bin("check-confidential"), "--staged"], env).out,
      "check-confidential",
    );
    expect(found.map((l) => l.replace(/.*\(/, "")).sort()).toEqual(["ZYX)", "jane q doe)"]);
    write(dir, { "a.md": "nothing\nzyx in lower case is a word here.\n" });
    sh(dir, ["add", "a.md"]);
    expect(run(dir, [bin("check-confidential"), "--staged"], env).code).toBe(0);
  });

  test("the tree audit reads every file, and a staged finding names a non-ASCII path as written", () => {
    const dir = repo({
      "package.json": "{}",
      "a.md": "nothing\n",
      "b.md": "We met jane q doe.\n",
      "c/d.md": "Every ZYX team.\n",
    });
    const audit = lines(
      run(dir, [bin("check-confidential"), "--tree", "HEAD"], env).out,
      "check-confidential",
    );
    expect(audit.map((l) => l.replace(/:.*\(/, " (")).sort()).toEqual([
      "[check-confidential] b.md (jane q doe)",
      "[check-confidential] c/d.md (ZYX)",
    ]);
    write(dir, { "café.md": "We met jane q doe.\n" });
    sh(dir, ["add", "café.md"]);
    sh(dir, ["config", "diff.mnemonicPrefix", "true"]);
    expect(run(dir, [bin("check-confidential"), "--staged"], env).out).toContain(
      "[check-confidential] café.md:",
    );
  });

  test("the tree audit checks a submodule's path and fails on an object it cannot read", () => {
    const dir = repo({ "package.json": "{}", "a.md": "nothing\n" });
    const head = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
    sh(dir, ["update-index", "--add", "--cacheinfo", `160000,${head},ZYX`]);
    sh(dir, ["commit", "-qm", "sub"]);
    expect(run(dir, [bin("check-confidential"), "--tree", "HEAD"], env).out).toContain("(ZYX)");
    const sha = sh(dir, ["rev-parse", "HEAD:a.md"]).stdout.toString().trim();
    rmSync(join(dir, ".git/objects", sha.slice(0, 2), sha.slice(2)));
    const broken = run(dir, [bin("check-confidential"), "--tree", "HEAD"], env);
    expect(broken.out).toContain("a.md not readable");
    expect(broken.code).not.toBe(0);
  });

  test("a one-word name in capitals matches only in capitals, a dictionary word included", () => {
    const caps = join(temp(), "caps.txt");
    writeFileSync(caps, "QUUX\nBRIDGE\nWidgetco\n");
    const capsList = join(temp(), "caps.json");
    writeFileSync(capsList, run(temp(), [bin("check-confidential"), "build", caps]).out);
    const capsEnv = { SCAFFOLDING_CONFIDENTIAL_TERMS: capsList, CI: "" };
    const dir = repo({ "package.json": "{}", "a.md": "nothing\n" });
    write(dir, { "a.md": "nothing\nQUUX and BRIDGE ship, so does widgetco.\n" });
    sh(dir, ["add", "a.md"]);
    const found = lines(
      run(dir, [bin("check-confidential"), "--staged"], capsEnv).out,
      "check-confidential",
    );
    expect(found.map((l) => l.replace(/.*\(/, "")).sort()).toEqual([
      "BRIDGE)",
      "QUUX)",
      "widgetco)",
    ]);
    write(dir, { "a.md": "nothing\nquux, Quux, the bridge and a Bridge stay ordinary words.\n" });
    sh(dir, ["add", "a.md"]);
    expect(run(dir, [bin("check-confidential"), "--staged"], capsEnv).code).toBe(0);
    write(dir, { "a.md": "nothing\nsee docs/quux-workshop/index.html\n" });
    sh(dir, ["add", "a.md"]);
    expect(
      lines(run(dir, [bin("check-confidential"), "--staged"], capsEnv).out, "check-confidential"),
    ).toHaveLength(1);
  });

  test("only added lines count", () => {
    const dir = repo({ "package.json": "{}", "a.md": "Acme Widgets GmbH\n" });
    write(dir, { "a.md": "Acme Widgets GmbH\nmore\n" });
    sh(dir, ["add", "a.md"]);
    expect(run(dir, [bin("check-confidential"), "--staged"], env).code).toBe(0);
  });

  test("the commit message is checked", () => {
    const dir = repo({ "package.json": "{}" });
    const msg = join(dir, "MSG");
    writeFileSync(msg, "fix: for Acme Widgets\n");
    expect(run(dir, [bin("check-confidential"), "--message-file", msg], env).out).toContain(
      "(Acme Widgets)",
    );
    writeFileSync(
      msg,
      "fix\n# ------------------------ >8 ------------------------\n+Acme Widgets\n",
    );
    expect(run(dir, [bin("check-confidential"), "--message-file", msg], env).code).toBe(0);
  });

  test("an image under docs/agent-work passes once read clean; one that cannot be read goes red", () => {
    const dir = repo({ "package.json": "{}" });
    mkdirSync(join(dir, "docs/agent-work/review"), { recursive: true });
    writeFileSync(join(dir, "docs/agent-work/review/shot.png"), PNG);
    sh(dir, ["add", "docs/agent-work/review/shot.png"]);
    expect(run(dir, [bin("check-confidential"), "--staged"], { ...env, CI: "" }).code).toBe(0);
    write(dir, { "docs/agent-work/review/broken.png": "not really a png" });
    sh(dir, ["add", "docs/agent-work/review/broken.png"]);
    const r = run(dir, [bin("check-confidential"), "--staged"], { ...env, CI: "" });
    expect(r.out).toContain("docs/agent-work/review/broken.png: image not read");
    expect(r.code).toBe(1);
  });

  test("review findings: comment lines, file names, decomposed text and '++ ' lines count", () => {
    const dir = repo({ "package.json": "{}" });
    const msg = join(dir, "MSG");
    writeFileSync(msg, "# Acme Widgets deal\n");
    expect(run(dir, [bin("check-confidential"), "--message-file", msg], env).code).toBe(1);
    write(dir, {
      "notes/acme-widgets.md": "x\n",
      "a.md": "Jane Q Doe".normalize("NFD") + "\n++ Acme Widgets\n",
    });
    sh(dir, ["add", "notes/acme-widgets.md", "a.md"]);
    const found = lines(
      run(dir, [bin("check-confidential"), "--staged"], env).out,
      "check-confidential",
    );
    expect(found).toContain(
      "[check-confidential] notes/acme-widgets.md: confidential term from the company records in the file's path: rename the file to a generic or fictitious name. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (acme widgets)",
    );
    expect(found).toEqual(
      expect.arrayContaining([
        matchingText(/^\[check-confidential\] a\.md:.*\(Jane Q Doe\)$/),
        matchingText(/^\[check-confidential\] a\.md:.*\(Acme Widgets\)$/),
      ]),
    );
    expect(found).toHaveLength(3);
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
      lines(run(dir, [bin("check-confidential"), "--staged"], env).out, "check-confidential"),
    ).toEqual([
      "[check-confidential] notes.sql: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Acme Widgets)",
    ]);
  });

  test("CI skips the term scan in a full audit only, never in a commit's own scans", () => {
    const dir = repo({ "package.json": "{}", "a.md": "nothing\n" });
    write(dir, { "a.md": "nothing\nAcme Widgets\n" });
    sh(dir, ["add", "a.md"]);
    const ci = { ...env, CI: "true" };
    expect(run(dir, [bin("check-confidential"), "--index"], ci).code).toBe(0);
    expect(run(dir, [bin("check-confidential"), "--staged"], ci).out).toContain("(Acme Widgets)");
    const msg = join(dir, "MSG");
    writeFileSync(msg, "for Acme Widgets\n");
    expect(run(dir, [bin("check-confidential"), "--message-file", msg], ci).code).toBe(1);
  });

  test("terms the scan could not produce: seven words, two characters, a three-letter slug", () => {
    const terms = join(temp(), "short.txt");
    writeFileSync(terms, "Alpha Bravo Charlie Delta Echo Foxtrot Golfo\nK 2\nZYX\n");
    const shortList = join(temp(), "short.json");
    writeFileSync(shortList, run(temp(), [bin("check-confidential"), "build", terms]).out);
    const shortEnv = { SCAFFOLDING_CONFIDENTIAL_TERMS: shortList, CI: "" };
    const found = (text: string) =>
      lines(
        run(
          repo({ "package.json": "{}", "a.md": text }),
          [bin("check-confidential"), "--index"],
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

  describe("scanning a document, a font and an unreadable binary", () => {
    let dir: string;
    let staged: string[];
    let indexed: string[];
    let cached: string[];
    const findings = (mode: string) =>
      lines(run(dir, [bin("check-confidential"), mode], env).out, "check-confidential").sort();
    beforeAll(() => {
      dir = repo({ "package.json": "{}" });
      // Word splits a sentence into runs, here inside a word and between two.
      mkdirSync(join(dir, "d/word"), { recursive: true });
      write(dir, {
        "d/word/document.xml":
          '<?xml version="1.0"?><w:document><w:p><w:r><w:t>We met Acme Wid</w:t></w:r><w:r><w:t>gets</w:t></w:r></w:p><w:p><w:r><w:t>and Jane Q</w:t></w:r><w:r><w:t xml:space="preserve"> Doe</w:t></w:r></w:p></w:document>',
      });
      prepareCommand(join(dir, "d"), ["zip", "-qr", "../offer.docx", "word"]);
      rmSync(join(dir, "d"), { recursive: true });
      writeFileSync(join(dir, "font.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2]));
      writeFileSync(join(dir, "data.bin"), Buffer.from("x\0y ZYX"));
      sh(dir, ["add", "offer.docx", "font.woff2", "data.bin"]);
      staged = findings("--staged");
      indexed = findings("--index");
      cached = findings("--index");
    });
    const expected = [
      "[check-confidential] data.bin: binary file not read: remove the binary or replace it with a text or scannable format so confidential terms cannot slip into this public repository. Only if the binary genuinely belongs here and contains no confidential data, add an entry with a reason in package.json scaffolding.allow",
      "[check-confidential] offer.docx: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Acme Widgets)",
      "[check-confidential] offer.docx: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Jane Q Doe)",
    ];
    test.each([
      ["staged", () => staged],
      ["index", () => indexed],
      ["cached index", () => cached],
    ])("reports the same findings in %s mode", (_, read) => {
      expect(read()).toEqual(expected);
    });
    test("caches just the readable document and font", () => {
      expect(readdirSync(join(dir, "node_modules/.cache/scaffolding/read"))).toHaveLength(2);
    });
  });

  test("changing just the XML decoder invalidates cached document text", () => {
    const dir = repo({ "package.json": "{}" });
    write(dir, { "word/document.xml": "<w:t>Acme&nbsp;Widgets</w:t>" });
    prepareCommand(dir, ["zip", "-qr", "document.docx", "word"]);
    prepareGit(dir, ["add", "document.docx"]);
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
      matchingText(/^[a-f0-9]{32}$/),
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
    expect(second, second.output).toEqual({
      status: 1,
      output: containingText(
        "document.docx: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Acme Widgets)",
      ),
    });
  });

  describe("Git LFS content in staged and index scans", () => {
    const modes = ["--staged", "--index"];
    const reports = new Map<string, Map<string, string[]>>();
    let dir: string;
    const record = (state: string) => {
      reports.set(
        state,
        new Map(
          modes.map((mode) => [
            mode,
            lines(run(dir, [bin("check-confidential"), mode], env).out, "check-confidential"),
          ]),
        ),
      );
    };
    const term =
      "[check-confidential] offer.docx: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow";
    const document = `${term} (Acme Widgets)`;
    const missing = "[check-confidential] offer.docx: Git LFS pointer, not read";
    beforeAll(() => {
      dir = repo({ "package.json": "{}" });
      mkdirSync(join(dir, "d/word"), { recursive: true });
      write(dir, { "d/word/document.xml": "<w:t>We met Acme Widgets</w:t>" });
      prepareCommand(join(dir, "d"), ["zip", "-qr", "../offer.docx", "word"]);
      rmSync(join(dir, "d"), { recursive: true });
      const content = readFileSync(join(dir, "offer.docx"));
      const oid = createHash("sha256").update(content).digest("hex");
      // The index holds the pointer git-lfs would stage, the working tree the file it names.
      const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`;
      const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: pointer })
        .stdout.toString()
        .trim();
      sh(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},offer.docx`]);
      record("working tree");
      // A working tree that differs from the pointer is not what the index holds; the store is.
      writeFileSync(join(dir, "offer.docx"), "changed since");
      record("missing");
      const stored = join(dir, ".git/lfs/objects", oid.slice(0, 2), oid.slice(2, 4));
      mkdirSync(stored, { recursive: true });
      writeFileSync(join(stored, oid), content);
      record("LFS store");
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
      record("LFS text");
      // A text that only starts like a pointer is read as text.
      write(dir, {
        "lfs.md": "version https://git-lfs.github.com/spec/v1\nWe met Acme Widgets.\n",
      });
      sh(dir, ["add", "lfs.md"]);
      record("ordinary text");
    });

    describe.each(modes)("%s", (mode) => {
      test.each([
        ["working tree", [document]],
        ["missing", [missing]],
        ["LFS store", [document]],
        [
          "LFS text",
          [
            document,
            "[check-confidential] notes.json: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Jane Q Doe)",
          ],
        ],
        [
          "ordinary text",
          [
            document,
            "[check-confidential] notes.json: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Jane Q Doe)",
            `${term.replace("offer.docx", "lfs.md")} (Acme Widgets)`,
          ],
        ],
      ])("reports the contents of %s", (state, expected) => {
        const modesForState = reports.get(state);
        assert(modesForState, `the report for ${state}`);
        const findings = modesForState.get(mode);
        assert(findings, `the ${mode} report for ${state}`);
        expect(findings.toSorted()).toEqual(expected.toSorted());
      });
    });
  });

  test("no setting or name changes what is read, and a damaged archive is refused", () => {
    const dir = repo({ "package.json": "{}" });
    mkdirSync(join(dir, "d/word"), { recursive: true });
    write(dir, {
      "d/word/document.xml": "<w:document><w:p>Acme Widgets &#99999999;</w:p></w:document>",
      ".gitattributes": "*.docx diff=shown\n",
      "b.md": "for Jane Q Doe\n",
    });
    prepareCommand(join(dir, "d"), ["zip", "-qr", "../offer.docx", "word"]);
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
      lines(run(dir, [bin("check-confidential"), "--staged"], env).out, "check-confidential")
        .map((l) => l.replace(/ \([^()]*\)(?=\. |$)/, ""))
        .sort(),
    ).toEqual([
      "[check-confidential] b.md: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow",
      "[check-confidential] broken.zip: archive not read: damaged zip archive. Replace the damaged, encrypted, or unsupported archive with plain files or a standard unencrypted ZIP (stored/deflate) so its contents can be scanned, or remove it from the repository",
      "[check-confidential] logo.woff: binary file not read: remove the binary or replace it with a text or scannable format so confidential terms cannot slip into this public repository. Only if the binary genuinely belongs here and contains no confidential data, add an entry with a reason in package.json scaffolding.allow",
      "[check-confidential] offer.docx: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow",
    ]);
  });

  test.runIf(process.platform === "darwin")(
    "OCR reads a transparent image, every page of a TIFF and a PDF page without text or with an image",
    () => {
      const dir = repo({ "package.json": "{}" });
      const make = (args: string[]) => prepareCommand(dir, args);
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
          defined(
            new RegExp(`${key}: (\\d+)`).exec(
              spawnSync("sips", ["-g", key, "figure.jpg"], { cwd: dir }).stdout.toString(),
            ),
            `sips ${key} output`,
          )[1],
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
      const streamEnd = Buffer.from("\nendstream");
      const bodies = objects.map((body) => [Buffer.from(body, "latin1")]);
      bodies[5].push(jpeg, streamEnd);
      bodies.forEach((body, i) => {
        offsets.push(size());
        parts.push(Buffer.from(`${i + 1} 0 obj\n`, "latin1"), ...body, Buffer.from("\nendobj\n"));
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
        lines(
          run(dir, [bin("check-confidential"), "--staged"], env).out,
          "check-confidential",
        ).sort(),
      ).toEqual([
        "[check-confidential] clear.png: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Acme Widgets)",
        "[check-confidential] figure.pdf: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Jane Q Doe)",
        "[check-confidential] pages.tiff: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Jane Q Doe)",
        "[check-confidential] scan.pdf: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Jane Q Doe)",
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
    const r = run(dir, [bin("check-confidential"), "--staged"], {
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
      run(dir, [bin("check-confidential"), "--tree", "HEAD"], env).out,
      "check-confidential",
    );
    expect(audit).toEqual([
      `[check-confidential] package.json: allow entry matches nothing: remove this stale entry (or unused path/text item) from package.json scaffolding.allow (${JSON.stringify(gone)})`,
    ]);
    write(dir, { "b.md": "x\n" });
    sh(dir, ["add", "b.md"]);
    expect(run(dir, [bin("check-confidential"), "--staged"], env).code).toBe(0);
  });

  describe("a scan reads the allow list of its snapshot", () => {
    const entry = { check: "confidential", path: "people/jane/*", reason: "her own entry" };
    const pkg = (allow: object[]) => JSON.stringify({ scaffolding: { allow } });
    const audit = (dir: string, args = ["--index"]) =>
      run(dir, [bin("check-confidential"), ...args], env).out;
    const output = new Map<string, string>();
    let badRevision: ReturnType<typeof run>["code"];
    beforeAll(() => {
      const dir = repo({ "package.json": pkg([]), "a.md": "nothing\n" });
      // A commit adding a name's folder with its entry: the gate audits the index, HEAD has neither.
      write(dir, { "package.json": pkg([entry]), "people/jane/a.md": "Jane Q Doe\n" });
      sh(dir, ["add", "package.json", "people/jane/a.md"]);
      output.set("index with an added entry and file", audit(dir));
      output.set("HEAD before entry and file", audit(dir, ["--tree", "HEAD"]));
      // The staged entry covers the staged name while the working tree drops it.
      write(dir, { "package.json": pkg([]) });
      output.set("entry staged and absent on disk", audit(dir, ["--staged"]));
      // The entry only in the working tree covers nothing staged.
      sh(dir, ["add", "package.json"]);
      write(dir, { "package.json": pkg([entry]) });
      output.set("entry on disk only", audit(dir, ["--staged"]));
      sh(dir, ["add", "package.json"]);
      sh(dir, ["commit", "-qm", "jane"]);
      // A commit removing both: the index holds neither, HEAD both.
      sh(dir, ["rm", "-q", "people/jane/a.md"]);
      write(dir, { "package.json": pkg([]) });
      sh(dir, ["add", "package.json"]);
      output.set("index with both removed", audit(dir));
      output.set("HEAD with entry and file", audit(dir, ["--tree", "HEAD"]));
      // A name already committed, its entry staged: the commit adding the entry passes the gate.
      const named = repo({ "package.json": pkg([]), "people/jane/a.md": "Jane Q Doe\n" });
      output.set("file committed without entry", audit(named));
      write(named, { "package.json": pkg([entry]) });
      sh(named, ["add", "package.json"]);
      output.set("entry staged for committed file", audit(named));
      // A bad revision fails rather than read as a package without allow entries.
      badRevision = run(named, [bin("check-confidential"), "--tree", "nope"], env).code;
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
      output.set("unmerged", audit(named));
    });

    test.each([
      ["index with an added entry and file", /^$/],
      ["HEAD before entry and file", /^$/],
      ["entry staged and absent on disk", /^$/],
      ["entry on disk only", /\(Jane Q Doe\)/],
      ["index with both removed", /^$/],
      ["HEAD with entry and file", /^$/],
      ["file committed without entry", /\(Jane Q Doe\)/],
      ["entry staged for committed file", /^$/],
      ["unmerged", /a\.md: unmerged/],
    ] as const)("reports the result for %s", (scenario, finding) => {
      const result = output.get(scenario);
      assert(typeof result === "string", `the output for ${scenario}`);
      expect(result).toMatch(finding);
    });

    test("refuses a revision that cannot be read", () => {
      expect(badRevision).not.toBe(0);
    });
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
          [bin("check-confidential"), "--tree", "HEAD"],
          env,
        ).out,
        "check-confidential",
      );
    expect(audit("Jane Q Doe".normalize("NFD"), "JANE Q DOE and jane q doe\n")).toEqual([]);
    expect(audit("Jane-Q. Doe", "Jane Q Doe\n")).toEqual([]);
    expect(audit("Acme Widgets", "Acme Widgets GmbH\n")).toEqual([
      "[check-confidential] a.md: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Acme Widgets GmbH)",
    ]);
    expect(
      audit(
        ["jane q doe", "acme widgets gmbh", "acme widgets", "zyx"],
        "Jane Q Doe, Acme Widgets GmbH\n",
      ),
    ).toEqual([
      `[check-confidential] package.json: allow entry matches nothing: remove this stale entry (or unused path/text item) from package.json scaffolding.allow (${JSON.stringify(entry("zyx"))})`,
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
      [bin("check-confidential"), "--tree", "HEAD"],
      env,
    ).out;
    expect(lines(out, "check-confidential")).toEqual([
      "[check-confidential] other.md: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Jane Q Doe)",
      // Each path of the list dies with its own case; package.json's own entries are no case.
      `[check-confidential] package.json: allow entry matches nothing: remove this stale entry (or unused path/text item) from package.json scaffolding.allow (${JSON.stringify({ ...allow[0], path: "package.json" })})`,
      `[check-confidential] package.json: allow entry matches nothing: remove this stale entry (or unused path/text item) from package.json scaffolding.allow (${JSON.stringify({ ...allow[0], path: "gone/**" })})`,
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
          [bin("check-confidential"), "--tree", "HEAD"],
          env,
        ).out,
        "check-confidential",
      );
    const entry = { check: "confidential", text: "Acme Widgets", reason: "test" };
    const content =
      "[check-confidential] people/acme-widgets.md: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Acme Widgets)";
    const notes =
      "[check-confidential] notes/acme-widgets.md: confidential term from the company records in the file's path: rename the file to a generic or fictitious name. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (acme widgets)";
    expect(scan([{ ...entry, path: "people/**" }])).toEqual([notes]);
    expect(scan([{ ...entry, path: "file names" }])).toEqual([content]);
    // The entry says it is for the file names: the term in the same file's text stays red.
    expect(scan([{ ...entry, path: ["file names", "people/**"] }])).toEqual([notes, content]);
    const gone = { ...entry, path: ["file names", "people/**", "gone/**"] };
    expect(scan([gone])).toEqual([
      notes,
      content,
      `[check-confidential] package.json: allow entry matches nothing: remove this stale entry (or unused path/text item) from package.json scaffolding.allow (${JSON.stringify({ ...gone, path: "gone/**" })})`,
    ]);
  });

  test.runIf(process.platform === "darwin")(
    "an image whose name holds a term is still kept as read",
    () => {
      const dir = repo({ "package.json": "{}" });
      writeFileSync(join(dir, "acme-widgets.png"), PNG);
      sh(dir, ["add", "acme-widgets.png"]);
      const r = run(dir, [bin("check-confidential"), "--staged"], { ...env, CI: "" });
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
    expect(run(clean, [bin("check-confidential"), "--tree", "HEAD"], env).code).toBe(0);
    const named = repo({ "package.json": pkg({ description: "Acme Widgets" }), ...files });
    expect(
      lines(
        run(named, [bin("check-confidential"), "--tree", "HEAD"], env).out,
        "check-confidential",
      ),
    ).toEqual([
      "[check-confidential] package.json: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Acme Widgets)",
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
      lines(
        run(reasoned, [bin("check-confidential"), "--tree", "HEAD"], env).out,
        "check-confidential",
      ),
    ).toEqual([
      "[check-confidential] package.json: confidential term from the company records: remove or anonymise the name with a generic or fictitious placeholder. Only if this is a verified public false positive, add an allow entry with its reason in package.json scaffolding.allow (Acme Widgets)",
    ]);
    // The staged scan reads the added lines the same way.
    const staged = repo({ "package.json": "{}" });
    write(staged, { "package.json": pkg({}), ...files });
    sh(staged, ["add", "package.json", "a.md"]);
    expect(run(staged, [bin("check-confidential"), "--staged"], env).code).toBe(0);
  });

  test.runIf(process.platform === "darwin")("an image that cannot be decoded is refused", () => {
    const dir = repo({ "package.json": "{}" });
    write(dir, { "bad.png": "not an image at all" });
    sh(dir, ["add", "bad.png"]);
    const r = run(dir, [bin("check-confidential"), "--staged"], env);
    expect(r.out).toContain("bad.png: image not read");
    expect(r.code).toBe(1);
  });

  test("a repository marked private is not checked", () => {
    const dir = repo({ "package.json": JSON.stringify({ scaffolding: { private: true } }) });
    write(dir, { "a.md": "Acme Widgets GmbH\n" });
    sh(dir, ["add", "a.md"]);
    expect(run(dir, [bin("check-confidential"), "--staged"], env).code).toBe(0);
  });

  test("an unstaged private flag leaves the scan of the index on", () => {
    const dir = repo({ "package.json": "{}" });
    write(dir, {
      "package.json": JSON.stringify({ scaffolding: { private: true } }),
      "a.md": "Acme Widgets GmbH\n",
    });
    sh(dir, ["add", "a.md"]);
    const r = run(dir, [bin("check-confidential"), "--staged"], env);
    expect(r.out).toContain("a.md: confidential term");
    expect(r.code).toBe(1);
  });

  describe("a push checks purged commits", () => {
    type Result = { status: number | null; stderr: string };
    const results = new Map<string, Result>();
    beforeAll(() => {
      const remote = temp();
      sh(remote, ["init", "-q", "--bare"]);
      const dir = repo({ "package.json": "{}", "a.md": "a\n" });
      sh(dir, ["remote", "add", "origin", remote]);
      write(dir, { "b.md": "b\n" });
      sh(dir, ["add", "b.md"]);
      sh(dir, ["commit", "-qm", "purged"]);
      const purged = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
      write(dir, {
        ".confidential-purged.json": run(dir, [bin("check-confidential"), "purged", purged]).out,
      });
      const push = (sha: string, name = "origin", source = "refs/heads/main") =>
        spawnSync(process.execPath, [bin("check-confidential"), "prepush", name, remote], {
          cwd: dir,
          input: `${source} ${sha} refs/heads/main ${"0".repeat(40)}\n`,
          encoding: "utf8",
        });
      results.set("purged tip", push(purged));
      results.set("reflog expression", push(purged, "origin", "HEAD@{1 day ago}"));
      const clean = sh(dir, ["rev-parse", "HEAD~1"]).stdout.toString().trim();
      results.set("clean tip", push(clean));
      // A stale tracking ref and a fetched pull request that holds it hide nothing.
      sh(dir, ["update-ref", "refs/remotes/origin/main", purged]);
      sh(dir, ["update-ref", "refs/remotes/origin/pr/1", purged]);
      results.set("purged tip in stale remote refs", push(purged));
      results.set("purged tip on the backup remote", push(purged, "backup"));
      write(dir, { ".confidential-purged.json": '{"salt":"fixture"}' });
      results.set("malformed list with clean tip", push(clean));
      // A failed purged run can leave the list empty when redirected to that file.
      write(dir, { ".confidential-purged.json": "" });
      results.set("empty list with clean tip", push(clean));
    });
    const purged = /purged from this repository's history/;
    test.each([
      ["purged tip", 1, purged],
      ["reflog expression", 1, purged],
      ["clean tip", 0, /^$/],
      ["purged tip in stale remote refs", 1, purged],
      ["purged tip on the backup remote", 1, purged],
      ["malformed list with clean tip", 1, /the list in this checkout does not parse/],
      ["empty list with clean tip", 0, /^$/],
    ] as const)("checks %s", (scenario, status, stderr) => {
      const result = results.get(scenario);
      assert(result, `the result for ${scenario}`);
      expect({ status: result.status, stderr: result.stderr }).toEqual({
        status,
        stderr: matchingText(stderr),
      });
    });
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
      ".confidential-purged.json": run(dir, [bin("check-confidential"), "purged", purged]).out,
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
      const { salt, hashes } = jsonObject(
        run(dir, [bin("check-confidential"), "purged", ...shas]).out,
      );
      assert(Array.isArray(hashes), "the purged hash list");
      const listed: unknown[] = hashes;
      return { salt, hashes: listed };
    };
    const first = purged(["a".repeat(40)]);
    write(dir, { ".confidential-purged.json": JSON.stringify(first) });
    const both = purged(["b".repeat(40), "a".repeat(40)]);
    expect({ salt: both.salt, entries: both.hashes.length }).toEqual({
      salt: first.salt,
      entries: 2,
    });
    expect(both.hashes).toContain(first.hashes[0]);
    sh(dir, ["add", ".confidential-purged.json"]);
    write(dir, { ".confidential-purged.json": "" });
    expect(purged(["b".repeat(40)])).toEqual(both);
    write(dir, { ".confidential-purged.json": "{}" });
    expect(purged(["b".repeat(40)])).toEqual(both);
    sh(dir, ["add", ".confidential-purged.json"]);
    const malformed = run(dir, [bin("check-confidential"), "purged", "b".repeat(40)]);
    expect(malformed).toEqual({
      code: 1,
      out: containingText(".confidential-purged.json does not parse"),
    });
  });

  describe("prepush hands the refs to Git LFS only where the push may carry LFS content", () => {
    const results = new Map<
      string,
      { installed: number | null; unavailable: number | null; log: string }
    >();
    let beforeStore: string;
    let rawHasStore: boolean;
    let totalLog: string;
    beforeAll(() => {
      const stub = temp();
      const log = join(stub, "log");
      const lfs = '#!/bin/sh\n[ "$1" = version ] && exit 0\necho "$*" >> "$LFS_LOG"\nexit 3\n';
      writeFileSync(join(stub, "git-lfs"), lfs, { mode: 0o755 });
      // A PATH holding git alone, so the machine's own git-lfs stays out of reach.
      const bare = temp();
      symlinkSync(defined(Bun.which("git"), "git binary on PATH"), join(bare, "git"));
      writeFileSync(log, "");
      const logged = () => readFileSync(log, "utf8");
      const capture = (dir: string, remote = "origin", old = "0".repeat(40)) => {
        const length = logged().length;
        const [installed, unavailable] = [`${stub}:${bare}`, bare].map((PATH) => {
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
        });
        return { installed, unavailable, log: logged().slice(length) };
      };
      // Nothing of LFS: git-lfs is never started, installed or not; a .lfsconfig and an empty store
      // hold no objects.
      results.set("no LFS metadata", capture(repo({ "package.json": "{}" })));
      results.set("empty LFS config", capture(repo({ "package.json": "{}", ".lfsconfig": "" })));
      const stored = repo({ "package.json": "{}" });
      mkdirSync(join(stored, ".git/lfs/objects/ab/cd"), { recursive: true });
      results.set("empty local store", capture(stored));
      const moved = repo({ "package.json": "{}" });
      const elsewhere = temp();
      sh(moved, ["config", "lfs.storage", elsewhere]);
      results.set("empty redirected store", capture(moved));
      beforeStore = logged();
      // A store holding an object: git-lfs decides and its status is the hook's; without git-lfs the
      // push is refused.
      write(stored, { ".git/lfs/objects/ab/cd/abcd": "x" });
      results.set("local object", capture(stored));
      write(elsewhere, { "objects/ab/cd/abcd": "x" });
      results.set("redirected object", capture(moved));
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
      rawHasStore = existsSync(join(raw, ".git/lfs"));
      results.set("new raw filtered path", capture(raw));
      // The same path committed before the push, already on a remote: nothing to carry.
      write(raw, { "b.md": "b\n" });
      rawGit(["add", "b.md"]);
      rawGit(["commit", "-qm", "b"]);
      sh(raw, ["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
      results.set("already tracked on origin", capture(raw));
      // A second remote lacks what origin holds, so the path is new there.
      results.set("raw filtered path for a second remote", capture(raw, "backup"));
      // A push to a URL has no tracking refs: the remote's tip from the input counts instead.
      const before = sh(raw, ["rev-parse", "HEAD~1"]).stdout.toString().trim();
      results.set("URL with an existing remote tip", capture(raw, "/elsewhere.git", before));
      // .git/info/attributes counts as well.
      const info = repo({ "package.json": "{}", "a.bin": "x" });
      write(info, { ".git/info/attributes": "*.bin filter=lfs\n" });
      results.set("filter from info attributes", capture(info));
      // A lockable path: git-lfs refuses a change to a file someone else locked, LFS or not.
      results.set(
        "lockable path",
        capture(repo({ "package.json": "{}", ".gitattributes": "*.psd lockable\n", "a.psd": "x" })),
      );
      const renamed = repo({
        "package.json": "{}",
        ".gitattributes": "*.psd lockable\n",
        "a.psd": "x",
      });
      prepareGit(renamed, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      prepareGit(renamed, ["config", "diff.renames", "true"]);
      prepareGit(renamed, ["mv", "a.psd", "a.txt"]);
      prepareGit(renamed, ["commit", "-qm", "rename", "a.psd", "a.txt"]);
      results.set("rename from a lockable path", capture(renamed));
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
      results.set("merge resolution changes a lockable path", capture(merged));
      totalLog = logged();
    }, limit(20_000));

    const invoked = "pre-push origin x\n";
    const scenarios = [
      ["no LFS metadata", [0, 0], ""],
      ["empty LFS config", [0, 0], ""],
      ["empty local store", [0, 0], ""],
      ["empty redirected store", [0, 0], ""],
      ["local object", [3, 1], invoked],
      ["redirected object", [3, 1], invoked],
      ["new raw filtered path", [3, 1], invoked],
      ["already tracked on origin", [0, 0], ""],
      ["raw filtered path for a second remote", [3, 1], "pre-push backup x\n"],
      ["URL with an existing remote tip", [0, 0], ""],
      ["filter from info attributes", [3, 1], invoked],
      ["lockable path", [3, 1], invoked],
      ["rename from a lockable path", [3, 1], invoked],
      ["merge resolution changes a lockable path", [3, 1], invoked],
    ] as const;

    test.each(scenarios)("delegates to installed Git LFS for %s", (scenario, [code], log) => {
      const result = results.get(scenario);
      assert(result, scenario);
      expect(result.installed).toBe(code);
      expect(result.log).toBe(log);
    });

    test.each(scenarios)("handles unavailable Git LFS for %s", (scenario, [, code]) => {
      const result = results.get(scenario);
      assert(result, scenario);
      expect(result.unavailable).toBe(code);
    });

    test("the push fixture exercises each relevant history without creating an LFS store", () => {
      expect(rawHasStore).toBe(false);
      expect(beforeStore).toBe("");
      expect(totalLog).toBe(
        "pre-push origin x\n".repeat(3) + "pre-push backup x\n" + "pre-push origin x\n".repeat(4),
      );
    });
  });
});

// Invented stand-ins for the names h&w never shows: QZX three letters in capitals, ZWOX four, Brennwald a
// capitalised name with a legal form, Marigold a dictionary word the public text also carries.
describe("check-confidential never", () => {
  const dir = temp();
  writeFileSync(join(dir, "never.txt"), "QZX\nBrennwald AG\nMarigold\nZWOX\n");
  writeFileSync(join(dir, "public.txt"), "We like Marigold.\n");
  const build = (input: string, never = join(dir, "never.txt")) => {
    const r = spawnSync(
      process.execPath,
      [
        "--no-env-file",
        bin("check-confidential"),
        "build",
        "-",
        "--public",
        join(dir, "public.txt"),
        "--never",
        never,
      ],
      {
        cwd: dir,
        env: { ...process.env, SCAFFOLDING_LOAD: "0" },
        encoding: "utf8",
        input: input,
      },
    );
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const list = join(dir, "list.json");
  writeFileSync(list, build("Acme Widgets\nMarigold\n").out);
  const env = { SCAFFOLDING_CONFIDENTIAL_TERMS: list, CI: "" };
  // The never scan reads the working tree's package.json and needs no commit.
  const plain = repo({ "package.json": "{}" }, false);
  const never = (texts: unknown, at = plain, extra = {}) => {
    const overrides = { ...env, ...extra };
    const input = JSON.stringify(texts);
    const r = spawnSync(process.execPath, ["--no-env-file", bin("check-confidential"), "never"], {
      cwd: at,
      env: { ...process.env, SCAFFOLDING_LOAD: "0", ...overrides },
      encoding: "utf8",
      input,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
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

  test.each([
    [
      "\n\n",
      "--never: no name; not building. Pass at least one name via --never <file> (or after a NUL byte on stdin) and re-run `check-confidential build`",
    ],
    [
      "QZX\nQZ\n",
      "under three letters: QZ; not building. Remove or lengthen the sub-3-letter entries in the --never input (after legal-suffix stripping) and re-run `check-confidential build`",
    ],
    [
      "QZ AG\n",
      "under three letters: QZ AG; not building. Remove or lengthen the sub-3-letter entries in the --never input (after legal-suffix stripping) and re-run `check-confidential build`",
    ],
    [
      "Q 7\n",
      "under three letters: Q 7; not building. Remove or lengthen the sub-3-letter entries in the --never input (after legal-suffix stripping) and re-run `check-confidential build`",
    ],
  ])("build refuses invalid never input %#", (text, why) => {
    const names = join(temp(), "names.txt");
    writeFileSync(names, text);
    const r = build("Acme Widgets\n", names);
    expect(r.code).toBe(1);
    expect(r.out).toContain(why);
  });

  test("build refuses a missing never input", () => {
    const bareChild = spawnSync(
      process.execPath,
      ["--no-env-file", bin("check-confidential"), "build", "-", "--never"],
      {
        cwd: dir,
        env: { ...process.env, SCAFFOLDING_LOAD: "0" },
        encoding: "utf8",
        input: "Acme Widgets\n",
      },
    );
    const bare = { code: bareChild.status, out: `${bareChild.stdout}${bareChild.stderr}` };
    expect(bare.code).toBe(1);
    expect(bare.out).toContain(
      "--never: no name; not building. Pass at least one name via --never <file> (or after a NUL byte on stdin) and re-run `check-confidential build`",
    );
  });

  test("build accepts a name of at least three letters plus its legal form", () => {
    const names = join(temp(), "names.txt");
    writeFileSync(names, "QZX AG\n");
    expect(build("Acme Widgets\n", names).code).toBe(0);
  });

  test("build reads the never names from stdin after a NUL byte; without one it refuses", () => {
    const both = ["build", "-", "--never", "-"];
    const rChild = spawnSync(
      process.execPath,
      ["--no-env-file", bin("check-confidential"), ...both],
      {
        cwd: dir,
        env: { ...process.env, SCAFFOLDING_LOAD: "0" },
        encoding: "utf8",
        input: "Acme Widgets\nZWOX\n\0QZX\nBrennwald AG\n",
      },
    );
    const r = { code: rChild.status, out: `${rChild.stdout}${rChild.stderr}` };
    expect(r.code).toBe(0);
    // ZWOX before the NUL is a term: QZX two hashes, Brennwald AG and Brennwald one each.
    expect(jsonObject(r.out).hashes).toHaveLength(2);
    expect(jsonObject(r.out).never).toHaveLength(4);
    const noneChild = spawnSync(
      process.execPath,
      ["--no-env-file", bin("check-confidential"), ...both],
      {
        cwd: dir,
        env: { ...process.env, SCAFFOLDING_LOAD: "0" },
        encoding: "utf8",
        input: "Acme Widgets\nQZX\n",
      },
    );
    const none = { code: noneChild.status, out: `${noneChild.stdout}${noneChild.stderr}` };
    expect(none.code).toBe(1);
    expect(none.out).toContain(
      "--never: no name; not building. Pass at least one name via --never <file> (or after a NUL byte on stdin) and re-run `check-confidential build`",
    );
  });

  // The matching table of the never-shown names report, each name replaced by its stand-in.
  test.each([
    ["QZX", 1, true],
    ["Qzx", 1, true],
    ["qzx", 1, true],
    ["QZX-Lieferung", 1, true],
    ["QZX’s Team", 1, true],
    ["qzx-workshop", 1, true],
    ["/qzx-ops-training/a.svg", 1, true],
    ["Qzx-Wan Keqzx", 1, true],
    ["Brennwald", 1, true],
    ["BRENNWALD", 1, true],
    ["Brennwald-Projekt", 1, true],
    ["QZX Smart Systems", 1, true],
    ["Marigold", 1, true],
    ["marigold", 1, true],
    ["zwox", 1, true],
    ["Brennwalds", 0, false],
    ["Wir haben gestern im Büro über das Angebot gesprochen.", 0, false],
  ])("%s: exits %i", (text, code, refused) => {
    const r = never({ "deck/a": "Titel\n" + text });
    expect(r.code).toBe(code);
    expect(
      r.out.includes(
        "deck/a: a name h&w never shows from the company records: remove or anonymise the name with a generic or fictitious placeholder.",
      ),
    ).toBe(refused);
    expect(r.out).not.toContain("scaffolding.allow");
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
    expect(stale.out).toContain(
      "allow entry matches nothing: remove this stale entry (or unused path/text item) from package.json scaffolding.allow",
    );
    // A confidential entry is the public scans' own and covers no never name.
    write(at, {
      "package.json": JSON.stringify({
        scaffolding: { allow: [{ ...entry, check: "confidential" }] },
      }),
    });
    expect(never({ "deliveries/2026-qzx-a/deck": "QZX" }, at).code).toBe(1);
  });

  test.each([
    ["string", { deck: { slides: [{ title: "plain", notes: ["QZX"] }] } }, 1],
    ["key", { deck: { slides: [{ QZX: 1 }] } }, 1],
    ["plain text", { deck: { slides: [{ title: "plain", notes: ["text"] }] } }, 0],
  ])("a nested %s counts as scan input", (_, body, code) => {
    expect(never(body).code).toBe(code);
  });

  test("does not combine adjacent strings into an unmentioned name", () => {
    const { out } = never({ deck: ["met Brennwald", "AG today"] });
    expect(out, out).not.toContain("(Brennwald AG)");
  });

  test("reports a complete name in one string", () => {
    const { out } = never({ deck: ["met Brennwald AG today"] });
    expect(out, out).toContain("(Brennwald AG)");
  });

  test("a name in several strings of one value gives one finding", () => {
    expect(never({ deck: ["QZX here", "QZX there"] }).out).toContain("1 findings");
  });

  describe("never stdin input", () => {
    let at: string;
    beforeAll(() => {
      at = repo({
        "package.json": JSON.stringify({
          scaffolding: { allow: [{ check: "never-shown", reason: "everything" }] },
        }),
      });
    });
    test.each(["", "{}", "[]", "not json", '{"a": "x", "b": 1}', '{"a": [{}]}', '"QZX"'])(
      "refuses %j despite an allow entry",
      (input) => {
        const rChild = spawnSync(
          process.execPath,
          ["--no-env-file", bin("check-confidential"), "never"],
          {
            cwd: at,
            env: { ...process.env, SCAFFOLDING_LOAD: "0", ...env },
            encoding: "utf8",
            input: input,
          },
        );
        const r = { code: rChild.status, out: `${rChild.stdout}${rChild.stderr}` };
        expect(r.code).toBe(1);
        expect(r.out).toContain(
          'stdin: nothing to scan: stdin holds no {"<where>": <value>} object, each value a string or JSON holding one. Pipe a non-empty JSON object mapping each source key to its string or nested JSON text into `check-confidential never`',
        );
      },
    );
    test("accepts a plain-text entry", () => {
      expect(never({ a: "plain text" }).code).toBe(0);
    });
  });

  test("confidential never propagates an unreadable stdin descriptor", () => {
    const fd = openSync(plain, "r");
    try {
      const result = spawnSync(
        process.execPath,
        ["--no-env-file", bin("check-confidential"), "never"],
        {
          cwd: plain,
          env: { ...process.env, ...env },
          stdio: [fd, "pipe", "pipe"],
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("EISDIR");
    } finally {
      closeSync(fd);
    }
  });

  test.each([
    ["missing", undefined],
    ["empty", []],
  ] as const)("a list with a %s never section refuses", (_, section) => {
    const r = never({ a: "plain text" }, plain, {
      SCAFFOLDING_CONFIDENTIAL_TERMS: listWith(section),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("the list has no never section");
  });

  test("CI skips with a warning", () => {
    const r = never({ a: "QZX" }, plain, { CI: "true" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("CI: never scan skipped");
  });

  describe("never names in public commits", () => {
    let at: string;
    beforeAll(() => {
      at = repo({ "package.json": "{}", "a.md": "a\n" });
    });
    const staged = (text: string, terms = list) => {
      write(at, { "a.md": `a\n${text}\n` });
      prepareGit(at, ["add", "a.md"]);
      return run(at, [bin("check-confidential"), "--staged"], {
        ...env,
        SCAFFOLDING_CONFIDENTIAL_TERMS: terms,
      }).code;
    };

    test.each([
      ["QZX", 1],
      ["see qzx-workshop/", 1],
      ["ZWOX", 1],
      ["Brennwald", 1],
      ["brennwald", 1],
      ["bei Qzx", 0],
      ["zwox", 0],
      ["Zwox", 0],
      ["a marigold", 0],
      ["Marigold", 0],
    ])("returns %i for staged input %j", (text, expected) => {
      expect(staged(text), text).toBe(expected);
    });

    test.each([
      ["QZX Brennwald", 0],
      ["Acme Widgets", 1],
    ])("scans staged input %j with a list lacking never names", (text, expected) => {
      expect(staged(text, listWith(undefined))).toBe(expected);
    });

    test("refuses a never name in a commit message", () => {
      const msg = join(at, "MSG");
      writeFileSync(msg, "fix: deck for Brennwald\n");
      expect(run(at, [bin("check-confidential"), "--message-file", msg], env).code).toBe(1);
    });
  });
});

describe("check-confidential list source", () => {
  const names = join(temp(), "names.txt");
  writeFileSync(names, "Acme Widgets GmbH\n");
  const fresh = run(temp(), [bin("check-confidential"), "build", names]).out;
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
    const check = (extra: Record<string, string> = {}, args = ["--staged"], input?: string) => {
      const overrides = { ...env, ...extra };
      const r = spawnSync(process.execPath, ["--no-env-file", bin("check-confidential"), ...args], {
        cwd: dir,
        env: { ...process.env, SCAFFOLDING_LOAD: "0", ...overrides },
        encoding: "utf8",
        input,
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    return { dir, home, check, calls, cache };
  }

  test("fresh machine with access: fetches, caches and finds the term", () => {
    const m = machine({ gh: "ok" });
    const r = m.check();
    expect(r).toEqual({ code: 1, out: containingText("(Acme Widgets)") });
    expect(m.calls()).toBe(1);
    expect(readFileSync(m.cache, "utf8")).toBe(fresh);
    // Bun's own transpiler cache may land in HOME; the command writes nothing there.
    expect(readdirSync(m.home)).not.toContainEqual(matchingText(/^\.(?:config|cache)$/));
  });

  describe("the never scan's list", () => {
    const deck = JSON.stringify({ a: "QZX" });
    let withNever: string;
    beforeAll(() => {
      const neverNames = join(temp(), "never.txt");
      writeFileSync(neverNames, "QZX\n");
      withNever = run(temp(), [
        bin("check-confidential"),
        "build",
        names,
        "--never",
        neverNames,
      ]).out;
    });

    test("fetches and caches a list once for repeated scans", () => {
      const m = machine({ gh: "ok", remote: withNever });
      expect(m.check({}, ["never"], deck).out).toContain("(QZX)");
      expect(readFileSync(m.cache, "utf8")).toBe(withNever);
      m.check({}, ["never"], deck);
      expect(m.calls()).toBe(1);
    });

    test("refuses a list built ten days ago even if just fetched", () => {
      const result = machine({ gh: "ok", remote: builtDaysAgo(10, withNever) }).check(
        {},
        ["never"],
        deck,
      );
      expect(result).toEqual({
        code: 1,
        out: matchingText(/list built 10 days ago, more than 7[\s\S]*then run it again/),
      });
    });

    test("refreshes a usable list fetched before the never section existed", () => {
      const before = machine({ gh: "ok", remote: withNever, cache: fresh, cacheDays: 0.5 });
      expect(before.check({}, ["never"], deck).out).toContain("(QZX)");
      expect(before.calls()).toBe(1);
    });

    test("retries a missing never section at most hourly", () => {
      const denied = machine({ gh: "deny", cache: fresh, cacheDays: 0.5 });
      expect(denied.check({}, ["never"], deck).out).toContain("the list has no never section");
      expect(denied.check({}, ["never"], deck).out).toContain("copy without a never section");
      expect(denied.calls()).toBe(1);
    });
  });

  test("a copy fetched within the day is used without a fetch", () => {
    const m = machine({ gh: "deny", cache: fresh, cacheDays: 0.5 });
    expect(m.check().out).toContain("(Acme Widgets)");
    expect(m.calls()).toBe(0);
  });

  describe("a stale copy within 7 days", () => {
    let first: ReturnType<typeof run>, again: ReturnType<typeof run>;
    let firstFetches: number, totalFetches: number;
    beforeAll(() => {
      const m = machine({ gh: "deny", cache: builtDaysAgo(2), cacheDays: 2 });
      first = m.check();
      firstFetches = m.calls();
      again = m.check();
      totalFetches = m.calls();
    });

    test("warns and reports the term after a failed fetch", () => {
      expect(first.out).toContain("using the copy fetched before");
      expect(first.out).toContain("(Acme Widgets)");
      expect(first.out).not.toContain("Refused");
      expect(firstFetches).toBe(1);
    });

    test("does not retry a failed fetch within the hour", () => {
      expect(again.out).toContain("next fetch within the hour");
      expect(totalFetches).toBe(1);
    });
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

  test.each([
    {
      scenario: "the staged scan opts into scanning without a list",
      settings: { gh: "deny" },
      flags: ["--staged", "--list-optional"],
      code: 0,
      finding: /--list-optional: terms not scanned/,
    },
    {
      scenario: "the staged scan requires a list",
      settings: { gh: "deny" },
      flags: ["--staged"],
      code: 1,
      finding: /Refused/,
    },
    {
      scenario: "the local list is stale",
      settings: { gh: "deny", cache: builtDaysAgo(10), cacheDays: 2 },
      flags: ["--staged", "--list-optional"],
      code: 1,
      finding: /Refused/,
    },
    {
      scenario: "the available list matches a term",
      settings: { gh: "ok" },
      flags: ["--staged", "--list-optional"],
      code: 1,
      finding: /\(Acme Widgets\)/,
    },
    {
      scenario: "an index scan always needs a list",
      settings: { gh: "deny" },
      flags: ["--index", "--list-optional"],
      code: 1,
      finding: /Refused/,
    },
  ] as const)("checks an optional list when $scenario", ({ settings, flags, code, finding }) => {
    expect(machine(settings).check({}, [...flags])).toEqual({
      code,
      out: matchingText(finding),
    });
  });

  describe("--list-optional with a file this machine cannot read", () => {
    const optional = ["--staged", "--list-optional"];
    let PATH: string;
    let withoutList: ReturnType<typeof run>, withList: ReturnType<typeof run>;
    const unreadFiles = (dir: string) => {
      write(dir, { "a.md": "a\n", "talk.pdf": "%PDF-1.4" });
      writeFileSync(join(dir, "shot.png"), PNG);
      prepareGit(dir, ["add", "a.md", "shot.png", "talk.pdf"]);
    };

    beforeAll(() => {
      const noOcr = temp();
      writeFileSync(join(noOcr, "swiftc"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      PATH = `${noOcr}:${stubDir}:/usr/bin:/bin`;
      const none = machine({ gh: "deny" });
      unreadFiles(none.dir);
      withoutList = none.check({ PATH }, optional);
      const list = join(none.home, "list.json");
      writeFileSync(list, fresh);
      withList = none.check({ PATH, SCAFFOLDING_CONFIDENTIAL_TERMS: list }, optional);
    });

    test("passes the unread file without a list and reports both files", () => {
      expect(withoutList.code, withoutList.out).toBe(0);
      expect(withoutList.out).toContain("shot.png: image not read");
      expect(withoutList.out).toContain("talk.pdf: PDF not read");
      expect(withoutList.out).toContain("--list-optional: passed unread");
    });

    test("refuses an unread file after the list becomes available", () => {
      expect(withList.code, withList.out).toBe(1);
      expect(withList.out).toContain("shot.png: image not read");
    });

    test("does not pass an unread file with a stale list", () => {
      const stale = machine({ gh: "deny", cache: builtDaysAgo(10), cacheDays: 2 });
      writeFileSync(join(stale.dir, "shot.png"), PNG);
      prepareGit(stale.dir, ["add", "shot.png"]);
      expect(stale.check({ PATH }, optional).out).not.toContain("passed unread");
    });
  });

  describe("--list-optional without a local copy", () => {
    let first: ReturnType<typeof run>,
      again: ReturnType<typeof run>,
      strict: ReturnType<typeof run>;
    let afterRetry: number, afterStrict: number, afterHour: number;
    beforeAll(() => {
      const m = machine({ gh: "deny" });
      const optional = ["--staged", "--list-optional"];
      first = m.check({}, optional);
      again = m.check({}, optional);
      afterRetry = m.calls();
      strict = m.check();
      afterStrict = m.calls();
      const attempt = `${m.cache}.attempt`;
      const hourAgo = (Date.now() - 3_700_000) / 1000;
      utimesSync(attempt, hourAgo, hourAgo);
      m.check({}, optional);
      afterHour = m.calls();
    });
    test("passes the first optional scan", () => {
      expect(first.code, first.out).toBe(0);
    });
    test("passes a repeat within the hour without asking again", () => {
      expect(again.code, again.out).toBe(0);
      expect(again.out).toContain("next fetch within the hour");
      expect(afterRetry).toBe(1);
    });
    test("tries again and refuses a strict commit scan", () => {
      expect(strict.code, strict.out).toBe(1);
      expect(afterStrict).toBe(2);
    });
    test("retrieves an optional list again after the hour", () => {
      expect(afterHour).toBe(3);
    });
  });

  test("CI skips the audit's term step without fetching, the path rule still holds", () => {
    const m = machine({ gh: "deny" });
    expect(m.check({ CI: "true" }, ["--index"]).code).toBe(0);
    expect(m.calls()).toBe(0);
    write(m.dir, { "docs/agent-work/shot.png": "x" });
    sh(m.dir, ["add", "docs/agent-work/shot.png"]);
    expect(m.check({ CI: "true" }, ["--index"]).out).toContain(
      "docs/agent-work/shot.png: binary file in docs/agent-work not read: no OCR in CI. Remove the binary from docs/agent-work/ or replace it with Markdown/text; only if it must live in this public repo, verify it locally on macOS and add an entry with a reason in package.json scaffolding.allow",
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
    names: "t",
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
    const left = run(gate({ skip, ...entry("unique-names") }), [bin("scaffolding"), "check"], lock);
    expect(left.out).toContain("scaffolding.allow names no check that reads it: unique-names");
    expect(left.code).toBe(1);
    // Control: a check that reads it.
    expect(
      run(gate({ skip, ...entry("spaces") }), [bin("scaffolding"), "check"], lock).out,
    ).not.toContain("names no check");
  });

  test("a runtime import cycle fails the gate under the step's name", () => {
    const { cycles: _c, ...rest } = skip;
    const dir = gate({ skip: rest });
    write(dir, {
      "a.ts": 'import { b } from "./b.ts";\nexport const a = (): number => b();\n',
      "b.ts": 'import { a } from "./a.ts";\nexport const b = (): number => a();\n',
    });
    prepareGit(dir, ["add", "--", "a.ts", "b.ts"]);
    const r = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/failed in [\d.]+ s: cycles/);
    expectGuideAfter(r.out, "import-cycle", "runtime import cycle");
  });

  describe("the names step in changed checks", () => {
    let dir: string;
    beforeAll(() => {
      const { names: _names, ...rest } = skip;
      dir = gate({ skip: rest });
      write(dir, {
        ".oxlintrc.json": JSON.stringify(oxlintTemplate),
        "a.js": "export function lookup() { return 1; }\n",
      });
      install(dir);
      prepareGit(dir, ["add", "--", ".oxlintrc.json", "a.js"]);
      prepareGit(dir, ["commit", "-qm", "add source"]);
      write(dir, { "README.md": "# Fixture\n" });
    });
    afterEach(() => rmSync(join(dir, "b.js"), { force: true }));
    const changed = () =>
      run(dir, [bin("scaffolding"), "check", "--changed"], { CHECK_LOCK: join(temp(), "lock") });
    test("skips names for a prose-only change", () => {
      const green = changed();
      expect(green, green.out).toEqual({
        code: 0,
        out: containingText("skipped names: no changed path maps to it"),
      });
    });
    test("rejects a duplicate from a changed source path", () => {
      write(dir, { "b.js": "export const lookup = () => 2;\n" });
      const red = changed();
      expect(red, red.out).toEqual({
        code: 1,
        out: containingText('selected names: matches "b.js"'),
      });
      expectGuideAfter(red.out, "duplicate-function-name", "is also declared in b.js");
    });
  });

  const layerMap = "docs/architecture/layers.md";
  const layerFixture = [
    "# Layers",
    "",
    "```mermaid",
    "graph LR",
    '  L0["src"]',
    '  L1["src/lib"]',
    '  L2["tools"]',
    "  L0 -->|2| L1",
    "  L1 -->|1| L2",
    "```",
    "",
    "## src",
    "",
    "| Forbidden import | Message           |",
    "| ---------------- | ----------------- |",
    "| `^private/`      | `Keep it in src.` |",
    "",
    "## src/lib",
    "",
    "| Forbidden import | Message                   |",
    "| ---------------- | ------------------------- |",
    "| `fs`             | `Use the storage module.` |",
    "",
  ].join("\n");

  describe("layers step checks the committed map", () => {
    let dir: string;
    let original: string;
    const check = () => run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    const stale =
      "docs/architecture/layers.md is stale: run `bun run scaffolding layers --write` and commit the file with this change.";
    beforeAll(() => {
      dir = gate({ skip });
      write(dir, {
        ".oxlintrc.json": JSON.stringify({
          overrides: [
            {
              files: ["src/**"],
              rules: {
                "no-restricted-imports": [
                  "error",
                  { patterns: [{ regex: "^private/", message: "Keep it in src." }] },
                ],
              },
            },
            {
              files: ["src/lib/**"],
              rules: {
                "eslint/no-restricted-imports": [
                  "warn",
                  { name: "fs", message: "Use the storage module." },
                ],
              },
            },
          ],
        }),
        "src/app.js":
          'import "./lib/store.js";\nimport { store } from "./lib/store.js";\nstore();\n',
        "src/lib/store.js":
          'import "./helper.js";\nimport "../../tools/build.js";\nexport function store() {}\n',
        "src/lib/helper.js": "export {};\n",
        "tools/build.js": "export {};\n",
      });
      prepareGit(dir, ["add", "--", "src", "tools"]);
      original = prepareGit(dir, ["rev-parse", "HEAD"]);
    });

    afterEach(() => {
      prepareGit(dir, ["reset", "--mixed", original]);
      prepareGit(dir, ["add", "--", "src", "tools"]);
      rmSync(join(dir, layerMap), { force: true });
    });

    test("generates the map to stdout without writing it", () => {
      expect(run(dir, [bin("scaffolding"), "layers"])).toEqual({ code: 0, out: layerFixture });
      expect(existsSync(join(dir, layerMap))).toBe(false);
    });

    test.each([
      ["missing", {}],
      ["stale", { [layerMap]: layerFixture.replace("L0 -->|2| L1", "L0 -->|1| L1") }],
    ])("rejects a %s layer map and prints its guide after the finding", (_, files) => {
      write(dir, files);
      const result = check();
      expect(result, result.out).toEqual({ code: 1, out: containingText(stale) });
      expectGuideAfter(result.out, "layers", stale);
    });

    test("accepts a newly generated and committed layer map", () => {
      const generated = run(dir, [bin("scaffolding"), "layers", "--write"]);
      requireFixtureSuccess("scaffolding layers --write", generated.code, generated.out);
      expect(readFileSync(join(dir, layerMap), "utf8")).toBe(layerFixture);
      prepareGit(dir, ["add", "--", layerMap]);
      prepareGit(dir, ["commit", "-qm", "generate layers"]);
      const fresh = check();
      expect(fresh.code, fresh.out).toBe(0);
      expect(fresh.out).toContain("ok   layers");
      expect(fresh.out).not.toContain("[guide] ");
    });
  });

  test("layers step requires a repository without layer overrides to have no map", () => {
    const dir = gate({ skip });
    write(dir, {
      ".oxlintrc.json":
        '{"overrides":[{"files":["src/**"],"rules":{"no-restricted-syntax":"error"}}]}',
    });
    const check = () => run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    const absent = check();
    expect(absent.code).toBe(0);
    expect(absent.out).toContain("ok   layers");
    write(dir, { [layerMap]: layerFixture });
    const unexpected = check();
    expect(unexpected.code).toBe(1);
    expect(unexpected.out).toContain("no layers declared: delete docs/architecture/layers.md");
  });

  const layerOverride = (files: string[], name = "private", message = "Use a public import.") => ({
    files,
    rules: { "no-restricted-imports": ["error", { paths: [{ name, message }] }] },
  });
  const withOverrides = (overrides: object[]) => JSON.stringify({ overrides });

  test.each(["js", "mjs", "cjs"])("layers count repeated imports in .%s files with JSX", (ext) => {
    const dir = repo({
      ".oxlintrc.json": withOverrides([layerOverride(["src/a/**"]), layerOverride(["src/b/**"])]),
      [`src/a/a.${ext}`]:
        'import { B } from "../b/b.js";\nimport "../b/b.js";\nexport const A = () => <B />;\n',
      "src/b/b.js": "export const B = () => null;\n",
    });
    const result = run(dir, [bin("scaffolding"), "layers"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('  L0["src/a"]\n  L1["src/b"]\n  L0 -->|2| L1');
  });

  test("layers name the source and the remedy when scanning fails", () => {
    const dir = repo({
      ".oxlintrc.json": withOverrides([layerOverride(["src/a/**"]), layerOverride(["src/b/**"])]),
      "src/a/a.ts": 'import "../b/b.ts";\nexport const broken = ;\n',
      "src/b/b.ts": "export {};\n",
    });
    const result = run(dir, [bin("scaffolding"), "layers"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("[layers] src/a/a.ts: cannot scan imports");
    expect(result.out).toContain("Fix the source syntax and rerun");
  });

  test("layers name the Oxlint config and the remedy when parsing fails", () => {
    const dir = repo({ ".oxlintrc.json": '{ /* comment */ "overrides": [ }\n' });
    const result = run(dir, [bin("scaffolding"), "layers"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("[layers] .oxlintrc.json: cannot parse the config");
    expect(result.out).toContain("Fix the config so it is a valid JSON object");
  });

  test("layers count source imports once across Astro frontmatter and scripts", () => {
    const dir = repo({
      ".oxlintrc.json": withOverrides([
        layerOverride(["src/pages/**"]),
        layerOverride(["src/components/**"]),
        layerOverride(["src/lib/**"]),
      ]),
      "src/pages/index.astro":
        '---\nimport { helper } from "../lib/helper.ts";\nimport Card from "../components/Card.astro";\n---\n<Card>{helper}</Card>\n<script>import "../lib/helper.ts";</script>\n',
      "src/lib/helper.ts": "export const helper = 1;\n",
      "src/components/Card.astro": "<slot />\n",
    });
    const result = run(dir, [bin("scaffolding"), "layers"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out.match(/ {2}L\d+ -->.*/g)).toEqual(["  L2 -->|1| L0", "  L2 -->|2| L1"]);
  });

  test.each(["./src/lib/**", "src\\lib\\**"])("layers normalize the glob %s", (glob) => {
    const dir = repo({
      ".oxlintrc.json": withOverrides([layerOverride([glob])]),
      "src/lib/a.js": 'import "../../tools/b.js";\n',
      "tools/b.js": "export {};\n",
    });
    const result = run(dir, [bin("scaffolding"), "layers"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('  L0["src/lib"]\n  L1["tools"]\n  L0 -->|1| L1');
  });

  test("layers rank narrower globs first when the literal prefix ties", () => {
    const dir = repo({
      ".oxlintrc.json": withOverrides([
        layerOverride(["src/**"]),
        layerOverride(["src/**/*.ts"]),
        layerOverride(["src/**/*.test.ts"]),
      ]),
      "src/a.js": 'import "./a.ts";\n',
      "src/a.ts": 'import "./a.test.ts";\n',
      "src/a.test.ts": 'import "./nested/b.test.ts";\n',
      "src/nested/b.test.ts": "export {};\n",
    });
    const result = run(dir, [bin("scaffolding"), "layers"]);
    expect(result.code, result.out).toBe(0);
    const [, graph] = result.out.split("```mermaid\n");
    assert(graph, "the Mermaid map");
    expect(graph.split("```")[0]).toBe(
      'graph LR\n  L0["src"]\n  L1["src/**/*.test.ts"]\n  L2["src/**/*.ts"]\n  L0 -->|1| L2\n  L2 -->|1| L1\n',
    );
  });

  test.each([
    {
      broad: "src/**/*.ts",
      narrow: "src/*.ts",
      target: "sub/deep.ts",
      body: 'L0["src/**/*.ts"]\n  L1["src/*.ts"]\n  L1 -->|1| L0',
    },
    {
      broad: "src/**/*",
      narrow: "src/*",
      target: "sub/deep.ts",
      body: 'L0["src/*"]\n  L1["src/**/*"]\n  L0 -->|1| L1',
    },
    {
      broad: "src/**/*.{ts,tsx}",
      narrow: "src/*.ts",
      target: "sub/deep.tsx",
      body: 'L0["src/**/*.{ts,tsx}"]\n  L1["src/*.ts"]\n  L1 -->|1| L0',
    },
    {
      broad: "src/*.{ts,tsx}",
      narrow: "src/*.ts",
      target: "deep.tsx",
      body: 'L0["src/*.ts"]\n  L1["src/*.{ts,tsx}"]\n  L0 -->|1| L1',
    },
  ])("layers distinguish $broad from $narrow", ({ broad, narrow, target, body }) => {
    const dir = repo({
      ".oxlintrc.json": withOverrides([layerOverride([broad]), layerOverride([narrow])]),
      "src/root.ts": `import "./${target}";\n`,
      [`src/${target}`]: "export {};\n",
    });
    const result = run(dir, [bin("scaffolding"), "layers"]);
    expect(result.code, result.out).toBe(0);
    const [, graph] = result.out.split("```mermaid\n");
    assert(graph, "the Mermaid map");
    expect(graph.split("```")[0]).toBe(`graph LR\n  ${body}\n`);
  });

  const tiedLayerNames = ["src/**/*y.js", "src/**/x*.js"];
  test.each([
    ["given order", tiedLayerNames],
    ["reverse order", [...tiedLayerNames].reverse()],
  ])("layers break equal specificity ties by layer name in %s", (_, order) => {
    const dir = repo({
      ".oxlintrc.json": withOverrides(order.map((name) => layerOverride([name]))),
      "src/a.js": 'import "./q/xy.js";\n',
      "src/q/xy.js": "export {};\n",
    });
    const result = run(dir, [bin("scaffolding"), "layers"]);
    expect(result.code, result.out).toBe(0);
    const [, graph] = result.out.split("```mermaid\n");
    assert(graph, "the Mermaid map");
    expect(graph.split("```")[0]).toBe(
      'graph LR\n  L0["src"]\n  L1["src/**/*y.js"]\n  L2["src/**/x*.js"]\n  L0 -->|1| L1\n',
    );
  });

  test("layers distinguish a top-level layer from its excluded files", () => {
    const dir = repo({
      ".oxlintrc.json": withOverrides([
        { ...layerOverride(["src/**"]), excludeFiles: ["src/excluded.js"] },
      ]),
      "src/a.js": 'import "./excluded.js";\n',
      "src/excluded.js": "export {};\n",
    });
    const result = run(dir, [bin("scaffolding"), "layers"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('  L0["src"]\n  L1["src (outside layers)"]\n  L0 -->|1| L1');
  });

  test("layers reject an empty excludeFiles glob", () => {
    const dir = repo({
      ".oxlintrc.json": withOverrides([{ ...layerOverride(["src/**"]), excludeFiles: [""] }]),
    });
    expect(run(dir, [bin("scaffolding"), "layers"])).toEqual({
      code: 1,
      out: "[layers] .oxlintrc.json: layer excludeFiles must list non-empty globs\n",
    });
  });

  test("layers merge duplicate normalized globs and keep both restrictions", () => {
    const dir = repo({
      ".oxlintrc.json": withOverrides([
        layerOverride(["src/**"], "first", "Use the first public import."),
        layerOverride(["src/**"], "second", "Use the second public import."),
        layerOverride(["./src/**"], "third", "Use the third public import."),
      ]),
    });
    const result = run(dir, [bin("scaffolding"), "layers"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out.match(/^## src$/gm)).toEqual(["## src"]);
    expect(result.out.match(/^ {2}L\d+\["src"\]$/gm)).toEqual(['  L0["src"]']);
    expect(result.out.match(/`(?:first|second|third)`/g)).toEqual([
      "`first`",
      "`second`",
      "`third`",
    ]);
  });

  test("layers generate a map accepted by format and markdown with markup in a message", () => {
    const { format: _f, markdown: _m, ...rest } = skip;
    const dir = gate({ skip: rest });
    const message = "Use <slot /> or <Foo> with *x* / _x_ and `foo` | bar.";
    write(dir, {
      ".oxlintrc.json": withOverrides([
        layerOverride(["src/**"], "private", message),
        layerOverride(["src/**"], "pipe", "Keep \\| literal.\nUse one line per item."),
      ]),
    });
    const generate = run(dir, [bin("scaffolding"), "layers", "--write"]);
    const map = readFileSync(join(dir, layerMap), "utf8");
    expect(generate.code, generate.out).toBe(0);
    prepareGit(dir, ["add", "--", layerMap]);
    const bins = join(dir, "node_modules/.bin");
    mkdirSync(bins, { recursive: true });
    symlinkSync(join(import.meta.dirname, "../node_modules/.bin/prettier"), join(bins, "prettier"));
    const formatInputs = spawnSync(
      process.execPath,
      ["--bun", "prettier", "--write", ".oxlintrc.json", "package.json"],
      { cwd: dir, encoding: "utf8" },
    );
    requireFixtureSuccess(
      "prettier --write .oxlintrc.json package.json",
      formatInputs.status,
      formatInputs.stdout + formatInputs.stderr,
    );
    const check = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(check.code, check.out).toBe(0);
    expect(
      Array.from(check.out.matchAll(/ok {3}(?:format|markdown)\b/g), ([line]) => line).sort(),
    ).toEqual(["ok   format", "ok   markdown"]);
    expect(readFileSync(join(dir, layerMap), "utf8")).toBe(map);
    expect(map.match(/^\| `(?:private|pipe)`.*$/gm)).toEqual([
      containingText("`Keep \\`<!-- -->`\\| literal.`<br>`Use one line per item.`"),
      containingText(message.replace("|", "\\|")),
    ]);
  });

  test("layers respect excludeFiles and independently match negated Oxlint globs", () => {
    const dir = repo({
      ".oxlintrc.json": withOverrides([
        { ...layerOverride(["src/lib/**"]), excludeFiles: ["./src/lib/excluded.js"] },
        layerOverride(["!src/**"]),
      ]),
      "src/lib/a.js": 'import "./excluded.js";\n',
      "src/lib/excluded.js": 'import "../../outside/b.js";\n',
      "outside/b.js": "export {};\n",
    });
    const result = run(dir, [bin("scaffolding"), "layers"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out.match(/ {2}L\d+ -->.*/g)).toEqual(["  L1 -->|1| L0", "  L2 -->|1| L1"]);
  });

  test.each([
    ["src/a.ts", true],
    ["src/a.astro", true],
    [".oxlintrc.json", true],
    [layerMap, true],
    ["docs/other.md", false],
  ])("layers selection for %s", (path, selected) => {
    const result = new ChangedStepSelector(new Set(["layers", "cycles"]), [], []).select({
      paths: new Set([path]),
      shellShebangs: new Set(),
      sourcedPaths: new Set(),
      since: "HEAD",
    });
    expect(result.steps.has("layers")).toBe(selected);
  });

  describe("tracked Markdown in the gate", () => {
    let dir: string;
    beforeAll(() => {
      const { markdown: _m, ...rest } = skip;
      dir = gate({ skip: rest });
      write(dir, { "record.md": "Body without a title.\n" });
      prepareGit(dir, ["add", "--", "record.md"]);
    });
    afterEach(() => write(dir, { "record.md": "Body without a title.\n" }));
    const check = () => run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });

    test("fails the Markdown step and prints its repair command once", () => {
      const result = check();
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain("record.md:1 error MD041");
      expect(result.out).toMatch(/failed in [\d.]+ s: markdown/);
      expect(result.out.split("\n").filter((line) => line === markdownRepair)).toEqual([
        markdownRepair,
      ]);
    });

    test("passes a clean Markdown file without a repair command", () => {
      write(dir, { "record.md": "# Body without a title.\n" });
      const result = check();
      expect(result).toEqual({ code: 0, out: withoutText(markdownRepair) });
    });
  });

  test("the gate accepts Markdown content folders and runs the Markdown step", () => {
    const { markdown: _m, ...rest } = skip;
    const dir = gate({ skip: rest, markdown: { content: ["articles"] } });
    write(dir, { "articles/post.md": "Body with <span>inline HTML</span>.\n" });
    prepareGit(dir, ["add", "--", "articles/post.md"]);
    const result = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(result.code, result.out).toBe(0);
  });

  describe("tracked shell code in the gate", () => {
    let dir: string;
    let env: Record<string, string>;
    beforeAll(() => {
      const { shell: _s, ...rest } = skip;
      dir = gate({ skip: rest });
      write(dir, { "script.sh": shellScript });
      prepareGit(dir, ["add", "--", "script.sh"]);
      env = { CHECK_LOCK: join(dir, ".lock"), ...shellcheckFixture(dir) };
    });
    afterEach(() => write(dir, { "script.sh": shellScript }));
    const check = () => run(dir, [bin("scaffolding"), "check"], env);

    test("fails the shell step and prints its repair command once", () => {
      const result = check();
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain("SC2034");
      expect(result.out).toMatch(/failed in [\d.]+ s: shell/);
      expect(result.out.split("\n").filter((line) => line === shellRepair)).toEqual([shellRepair]);
    });

    test("passes a clean shell script without a repair command", () => {
      write(dir, { "script.sh": "#!/bin/sh\necho ready\n" });
      const result = check();
      expect(result).toEqual({ code: 0, out: withoutText(shellRepair) });
    });
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
    const r = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.out).toContain("ok   lint");
    expect(r.out).toContain("ok   oxlint");
    expect(r.code).toBe(0);
  });

  describe.each([
    {
      linter: "oxlint",
      id: "no-self-assign",
      finding: "eslint(no-self-assign)",
      broken: "let value = 0;\nvalue = value;\nconsole.log(value);\n",
    },
    {
      linter: "lint",
      id: "no-useless-assignment",
      finding: "no-useless-assignment",
      broken: "let value = 0;\nvalue = 1;\nconsole.log(value);\n",
    },
  ])("gate rule guides for $linter", ({ id, finding, broken }) => {
    let dir: string;
    const clean = "console.log(1);\n";
    beforeAll(() => {
      const { lint: _l, ...rest } = skip;
      dir = gate({ skip: rest });
      write(dir, {
        ".oxlintrc.json": JSON.stringify(oxlintTemplate),
        "eslint.config.js": 'export { default } from "@hackersandwizards/scaffolding/eslint";\n',
        "a.js": clean,
      });
      install(dir);
      symlinkSync(
        join(import.meta.dirname, "../node_modules/.bin"),
        join(dir, "node_modules/.bin"),
      );
    });
    afterEach(() => {
      write(dir, { "a.js": clean });
      rmSync(join(dir, "b.js"), { force: true });
    });
    const check = () => run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });

    test("prints one guide after a single finding", () => {
      write(dir, { "a.js": broken });
      const single = check();
      expect(single, single.out).toEqual({ code: 1, out: containingText(finding) });
      expectGuideAfter(single.out, id, finding);
    });

    test("prints one guide for two findings", () => {
      write(dir, { "a.js": broken, "b.js": broken });
      const double = check();
      expect(double.code, double.out).toBe(1);
      const beforeGuide = double.out.split("[guide]")[0];
      expect(beforeGuide.split(finding).length - 1).toBe(2);
      expectGuide(double.out, id);
    });

    test("prints no guide on a pass", () => {
      write(dir, { "b.js": clean });
      const green = check();
      expect(green, green.out).toEqual({ code: 0, out: withoutText("[guide] ") });
    });
  });

  test("runs the repository's steps in order and passes", () => {
    const dir = gate({ skip, check: ["mine", ["true", "true"]] }, { mine: "echo ran-mine" });
    const r = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
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
    const r = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.out).not.toContain("vendor/inner");
    expect(r.code, r.out).toBe(0);
  });

  describe("environment files in the gate", () => {
    let dir: string;
    beforeAll(() => {
      const probe = `sh -c 'echo sh=\${SCAF_TEST_SECRET:-none}' && bun probe.ts && echo options=[$BUN_OPTIONS]`;
      dir = gate({ skip, check: ["check:probe"] }, { "check:probe": probe });
      write(dir, {
        ".env": "SCAF_TEST_SECRET=x\n",
        "probe.ts": 'console.log(`bun=${process.env.SCAF_TEST_SECRET ?? "none"}`);\n',
      });
    });
    // The parent gate hands its own BUN_OPTIONS down; each run here starts without it.
    const { BUN_OPTIONS: _, ...bare } = process.env;
    const plain = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, {
        cwd: dir,
        env: { ...bare, CHECK_LOCK: join(dir, ".lock") },
        encoding: "utf8",
      });

    test("direct Bun invocation loads the fixture environment file", () => {
      expect(plain(process.execPath, ["probe.ts"]).stdout).toContain("bun=x");
    });
    test.each([
      ["Bun", process.execPath, ["--no-env-file", bin("scaffolding"), "check"]],
      ["the command", bin("scaffolding"), ["check"]],
      ["portable sh", "/bin/sh", [bin("scaffolding"), "check"]],
    ])("keeps the environment file out of a gate invoked through %s", (_, command, args) => {
      const r = plain(command, args);
      const out = `${r.stdout}${r.stderr}`;
      expect(out).toContain("sh=none");
      expect(out).toContain("bun=none");
      // Once, though the gate re-runs itself under check-lock.
      expect(out).toContain("options=[--no-env-file]\n");
      expect(r.status).toBe(0);
    });

    test.each(["scaffolding", "check-staged"])(
      "%s rejects Bun's default env-file loading",
      (name) => {
        const loaded = plain(process.execPath, [bin(name), "check"]);
        expect(loaded.status).toBe(2);
        expect(loaded.stderr).toContain("--no-env-file");
      },
    );
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
    const mapped = run(dir, [bin("scaffolding"), "check", "--changed"], lock);
    expect(mapped.out).toContain("docs-ran");
    expect(mapped.out).not.toContain("src-ran");
    expect(mapped.out).toContain("[scaffolding] skipped check:src: no changed path maps to it");
    expect(mapped.code).toBe(0);
    // A file every step reads runs every step too.
    write(dir, { "bunfig.toml": "\n" });
    expect(run(dir, [bin("scaffolding"), "check", "--changed"], lock).out).toContain("src-ran");
  });

  test.each([
    {
      path: "docs/guide.md",
      text: "# Guide\n",
      step: "markdown",
      skipped: "shell",
      why: 'matches "docs/guide.md"',
    },
    {
      path: "scripts/.shellcheckrc",
      text: "# Defaults.\n",
      step: "shell",
      skipped: "markdown",
      why: 'matches "scripts/.shellcheckrc"',
    },
    {
      path: "scripts/script.bash",
      text: "#!/bin/bash\ntrue\n",
      step: "shell",
      skipped: "markdown",
      why: 'matches "scripts/script.bash"',
    },
    {
      path: "scripts/tool",
      text: "#!/usr/bin/env --split-string dash\ntrue\n",
      step: "shell",
      skipped: "markdown",
      why: 'matches shell shebang in "scripts/tool"',
    },
  ])("--changed selects the matching linter for $path", ({ path, text, step, skipped, why }) => {
    const { shell: _s, markdown: _m, ...rest } = skip;
    const dir = gate({ skip: rest });
    write(dir, { [path]: text });
    const r = run(dir, [bin("scaffolding"), "check", "--changed"], {
      CHECK_LOCK: join(temp(), "lock"),
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`selected ${step}: ${why}`);
    expect(r.out).toContain(`skipped ${skipped}: no changed path maps to it`);
  });

  test("--changed reads the removed shell shebang from the base of a pushed range", () => {
    const { shell: _s, markdown: _m, ...rest } = skip;
    const dir = gate({ skip: rest });
    write(dir, { "bin/tool": "#!/bin/ksh\ntrue\n" });
    prepareGit(dir, ["add", "--", "bin/tool"]);
    prepareGit(dir, ["commit", "-qm", "add script", "--", "bin/tool"]);
    const old = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
    prepareGit(dir, ["rm", "-q", "--", "bin/tool"]);
    prepareGit(dir, ["commit", "-qm", "remove script", "--", "bin/tool"]);
    const tip = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
    const r = run(dir, [bin("scaffolding"), "check", "--changed", `${old}..${tip}`], {
      CHECK_LOCK: join(temp(), "lock"),
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('selected shell: matches shell shebang in "bin/tool"');
    expect(r.out).toContain("skipped markdown: no changed path maps to it");
  });

  describe("--changed when a sourced tracked file changes", () => {
    let local: ReturnType<typeof run>, pushed: ReturnType<typeof run>;
    beforeAll(async () => {
      const { shell: _s, ...rest } = skip;
      const dir = gate({ skip: rest });
      write(dir, {
        "scripts/main.sh": '#!/bin/sh\n. ./lib/common.inc\nprintf "%s\\n" "$value"\n',
        "lib/common.inc": "value=before\n",
      });
      prepareGit(dir, ["add", "--", "scripts/main.sh", "lib/common.inc"]);
      prepareGit(dir, ["commit", "-qm", "add source", "--", "scripts/main.sh", "lib/common.inc"]);
      const base = prepareGit(dir, ["rev-parse", "HEAD"]);
      const env = { CHECK_LOCK: join(temp(), "lock"), ...(await realShellcheckFixture(dir)) };
      write(dir, { "lib/common.inc": "value=after\n" });
      local = run(dir, [bin("scaffolding"), "check", "--changed"], env);
      rmSync(join(dir, "lib/common.inc"));
      write(dir, { "scripts/main.sh": "#!/bin/sh\ntrue\n" });
      prepareGit(dir, ["add", "--", "scripts/main.sh", "lib/common.inc"]);
      prepareGit(dir, [
        "commit",
        "-qm",
        "remove source",
        "--",
        "scripts/main.sh",
        "lib/common.inc",
      ]);
      pushed = run(dir, [bin("scaffolding"), "check", "--changed", `${base}..HEAD`], env);
    });

    test("selects shell after an edit to the sourced file", () => {
      expect(local, local.out).toEqual({
        code: 0,
        out: containingText('selected shell: sources "lib/common.inc"'),
      });
    });
    test("selects shell when a push removes the sourced file and its reference", () => {
      expect(pushed, pushed.out).toEqual({
        code: 0,
        out: containingText('selected shell: sources "lib/common.inc"'),
      });
    });
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
    prepareGit(dir, ["add", "--", path]);
    prepareGit(dir, ["commit", "-qm", "change one file", "--", path]);
    const r = run(dir, [bin("scaffolding"), "check", "--changed", `${old}..HEAD`], {
      CHECK_LOCK: join(temp(), "lock"),
      ...shellcheckFixture(dir),
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("tests-ran");
    expect(
      Array.from(r.out.matchAll(/skipped (?:shell|markdown): fixture/g), ([line]) => line).sort(),
    ).toEqual(skipped.map((step) => `skipped ${step}: fixture`).sort());
  });

  describe.each([
    ["full", ["check"]],
    ["changed", ["check", "--changed"]],
  ])("%s gate configuration validation", (_, args) => {
    test.each([
      [{ changed: { "docs/**": "check:docs" } }, "is no list of steps"],
      [{ changed: { "docs/**": [] } }, "is an empty list of steps"],
      [{ changed: { "docs/**": ["check:dosc"] } }, "names no step: check:dosc"],
      [{ changed: { "docs/{md": ["check:docs"] } }, "is no repository-relative glob"],
      [{ fullOnly: { "check:typo": "builds output" } }, "names no eligible step: check:typo"],
      [{ fullOnly: { "check:docs": " " } }, "scaffolding.fullOnly.check:docs has no reason"],
    ])("validates path mappings and full-only declarations (%j)", (config, message) => {
      const dir = gate({ skip, check: ["check:docs"], ...config });
      const lock = { CHECK_LOCK: join(temp(), "lock") };
      const result = run(dir, [bin("scaffolding"), ...args], lock);
      expect(result.out).toContain(message);
      expect(result.code).toBe(1);
    });
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
    const quick = run(bare, [bin("scaffolding"), "check", "--changed"], lock);
    expect(quick.out).toContain("selected check:src: no path scope configured");
    expect(quick.out).toContain("src-ran");
    expect(quick.code).toBe(0);
    // Skill data outside the default map falls back to the fast gate.
    write(bare, { ".claude/skills/s/x.json": "{}\n" });
    expect(run(bare, [bin("scaffolding"), "check", "--changed"], lock).out).toContain(
      '".claude/skills/s/x.json" matches no path glob: all fast steps run',
    );
    const own = gate({ skip, ...steps, changed: { ".claude/**": ["check:src"] } }, scripts);
    write(own, { ".claude/rules/r.md": "r\n" });
    expect(run(own, [bin("scaffolding"), "check", "--changed"], lock).out).toContain(
      'selected check:src: matches ".claude/rules/r.md"',
    );
  });

  describe("--changed selects shared steps across pushed ranges", () => {
    type Outcome = ReturnType<typeof run>;
    const results = new Map<string, Outcome>();
    let full: Outcome;
    beforeAll(() => {
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
      const git = (...args: string[]) => prepareGit(dir, args).trim();
      const commit = (...paths: string[]) => {
        git("add", "--", ...paths);
        git("commit", "-qm", "fixture", "--", ...paths);
        return git("rev-parse", "HEAD");
      };
      const base = git("rev-parse", "HEAD");
      write(dir, { "docs/a.md": "a\n" });
      const docs = commit("docs/a.md");
      const docsRange = `${base}..${docs}`;
      const changed = (scenario: string, ...ranges: string[]) => {
        results.set(
          scenario,
          run(dir, [bin("scaffolding"), "check", "--changed", ...ranges], lock),
        );
      };
      changed("prose", docsRange);

      write(dir, { "docs/lint.md": "lint\n" });
      const lint = commit("docs/lint.md");
      changed("lint", `${docs}..${lint}`);

      write(dir, { "src/a.ts": "export {};\n", "src/b.ts": "export {};\n" });
      const source = commit("src/a.ts", "src/b.ts");
      changed("union", docsRange, `${lint}..${source}`);

      git("mv", "src/a.ts", "docs/renamed.md");
      git("commit", "-qm", "rename fixture", "--", "src/a.ts", "docs/renamed.md");
      const rename = git("rev-parse", "HEAD");
      changed("rename", `${source}..${rename}`);
      renameSync(join(dir, "src/b.ts"), join(dir, "node_modules/deleted.ts"));
      const deleted = commit("src/b.ts");
      changed("deletion", `${rename}..${deleted}`);

      write(dir, { "docs/yarn.lock": "" });
      const lockfile = commit("docs/yarn.lock");
      changed("lockfile", `${deleted}..${lockfile}`);
      changed("new branch", `${"0".repeat(40)}..${docs}`);
      changed("absent base commit", `${"1".repeat(40)}..${docs}`);
      changed("non-fast-forward", `${source}..${docs}`);

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
      changed("full-only test", `${lint}..${source}`);
      full = run(dir, [bin("scaffolding"), "check"], lock);
    }, limit(20_000));

    const rangeMessages =
      /skipped (?:lint|test): no changed path maps to it|selected typecheck: Astro lint needs generated types|(?:3|2) paths since|selected lint: matches "src\/a\.ts"|selected test: matches "src\/b\.ts"|is a shared configuration path|starts a new branch|starts at a commit this clone lacks|is not a verifiable fast-forward|deferred test: launches Chrome|(?:lint|test)-ran/g;
    test.each([
      [
        "prose",
        ["skipped lint: no changed path maps to it", "skipped test: no changed path maps to it"],
      ],
      [
        "lint",
        [
          "lint-ran",
          "selected typecheck: Astro lint needs generated types",
          "skipped test: no changed path maps to it",
        ],
      ],
      ["union", ["3 paths since", 'selected lint: matches "src/a.ts"', "lint-ran", "test-ran"]],
      ["rename", ["2 paths since", 'selected lint: matches "src/a.ts"', "lint-ran", "test-ran"]],
      ["deletion", ['selected test: matches "src/b.ts"', "lint-ran", "test-ran"]],
      ["lockfile", ["is a shared configuration path", "lint-ran", "test-ran"]],
      ["new branch", ["starts a new branch", "lint-ran", "test-ran"]],
      ["absent base commit", ["starts at a commit this clone lacks", "lint-ran", "test-ran"]],
      ["non-fast-forward", ["is not a verifiable fast-forward", "lint-ran", "test-ran"]],
      [
        "full-only test",
        [
          "2 paths since",
          'selected lint: matches "src/a.ts"',
          "deferred test: launches Chrome",
          "lint-ran",
        ],
      ],
    ] as const)("selects the steps for %s", (scenario, messages) => {
      const result = results.get(scenario);
      assert(result, `the gate result for ${scenario}`);
      expect(result.code, result.out).toBe(0);
      expect(new Set(result.out.match(rangeMessages)), result.out).toEqual(new Set(messages));
      expect(result.out).not.toMatch(/(?:catalog|preview)-ran/);
      expect(result.out).toContain("deferred catalog: builds the catalog");
      expect(result.out).toContain("deferred check:preview: builds a preview");
    });

    test("runs all three deferred steps in the full gate", () => {
      expect(full.code, full.out).toBe(0);
      const ran = full.out.match(/(?:catalog|preview|test)-ran/g);
      assert(ran, full.out);
      expect(ran.sort()).toEqual(["catalog-ran", "preview-ran", "test-ran"]);
    });
  });

  describe("a push checks the pushed range", () => {
    type Outcome = ReturnType<typeof run>;
    let first: Outcome,
      hub: Outcome,
      docs: Outcome,
      reflog: Outcome,
      code: Outcome,
      rules: Outcome,
      lacks: Outcome,
      tag: Outcome;
    let firstRefs: string,
      expectedFirstRefs: string,
      reflogRefs: string,
      expectedReflogRefs: string;
    beforeAll(() => {
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
      first = push(dir, "HEAD:refs/heads/main");
      // check-confidential got the refs git handed the hook, line for line.
      const head = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
      firstRefs = readFileSync(refs, "utf8");
      expectedFirstRefs = `HEAD ${head} refs/heads/main ${"0".repeat(40)}\n`;
      // Rules and skill prose run the quick steps alone, whatever else the working tree holds.
      commit(dir, { ".claude/rules/r.md": "r\n", ".claude/skills/s/SKILL.md": "s\n" });
      write(dir, { "other.txt": "another session's file\n" });
      hub = push(dir, "HEAD:refs/heads/main");
      // A mapped path runs its step.
      commit(dir, { "docs/b.md": "b\n" });
      docs = push(dir, "HEAD:refs/heads/main");
      const previous = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
      write(dir, { "docs/reflog.md": "reflog\n" });
      prepareGit(dir, ["add", "--", "docs/reflog.md"]);
      prepareCommand(dir, ["git", "commit", "-qm", "dated target", "--", "docs/reflog.md"], {
        ...process.env,
        GIT_COMMITTER_DATE: new Date(Date.now() - 172_800_000).toISOString(),
      });
      const target = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
      commit(dir, { "src/later.ts": "export {};\n" });
      reflog = push(dir, "HEAD@{1 day ago}:refs/heads/main");
      reflogRefs = readFileSync(refs, "utf8");
      expectedReflogRefs = `HEAD@{1 day ago} ${target} refs/heads/main ${previous}\n`;
      // From a detached linked worktree, which has no upstream, the range is still the pushed one.
      const tree = join(temp(), "tree");
      sh(dir, ["worktree", "add", "-q", "--detach", tree]);
      mkdirSync(join(tree, "node_modules"));
      commit(tree, { "src/a.ts": "export {};\n" });
      code = push(tree, "HEAD:refs/heads/main");
      commit(tree, { ".claude/rules/s.md": "s\n" });
      rules = push(tree, "HEAD:refs/heads/main");
      // A remote tip this clone lacks runs all fast steps.
      lacks = run(dir, [bin("scaffolding"), "check", "--changed", `${"1".repeat(40)}..HEAD`], env);
      // A tag carries no branch and requires no branch gate.
      sh(dir, ["tag", "v1"]);
      tag = push(dir, "refs/tags/v1");
    }, limit(60_000));

    test("runs all fast steps for a new branch and sends the branch's refs to the scan", () => {
      expect(first.code, first.out).toBe(0);
      expect(first.out).toContain("starts a new branch: all fast steps run");
      expect(first.out).toContain("src-ran");
      expect(firstRefs).toBe(expectedFirstRefs);
    });

    test("skips both mapped checks on rules and skill prose despite working tree changes", () => {
      expect(hub.code, hub.out).toBe(0);
      expect(hub.out).toContain("[scaffolding] skipped check:src: no changed path maps to it");
      expect(hub.out).toContain("[scaffolding] skipped check:docs: no changed path maps to it");
    });

    test("runs the docs check alone for a path mapped to it", () => {
      expect(docs.out).toContain("docs-ran");
      expect(docs.out).not.toContain("src-ran");
    });

    test("checks and passes on the refs of a reflog-selected commit", () => {
      expect(reflog.code, reflog.out).toBe(0);
      expect(reflog.out).not.toContain("src-ran");
      expect(reflog.out).toContain('selected check:docs: matches "docs/reflog.md"');
      expect(reflogRefs).toBe(expectedReflogRefs);
    });

    test("uses the pushed range from a detached linked worktree", () => {
      expect(code.out).toContain('selected check:src: matches "src/a.ts"');
      expect(code.out).toContain("src-ran");
    });

    test("skips the source check for a rules-only push from a detached worktree", () => {
      expect(rules.out).toContain("skipped check:src");
    });

    test("runs all fast steps if the base commit is absent", () => {
      expect(lacks.out).toContain("starts at a commit this clone lacks: all fast steps run");
    });

    test("pushes a tag without running the branch gate", () => {
      expect(tag, tag.out).toEqual({ code: 0, out: withoutText("check:src") });
    });
  });

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
    const r = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL false");
    expect(r.out).not.toContain("never-ran");
  });

  test("a step is reported when it ends, and the verdict names the red ones in order", () => {
    const dir = gate(
      { skip, check: [["check:slow", "check:fast", "check:also"]] },
      { "check:slow": "sleep 2; echo slow-done", "check:fast": "exit 1", "check:also": "exit 1" },
    );
    const r = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(1);
    expect(r.out.indexOf("FAIL check:fast")).toBeLessThan(r.out.indexOf("slow-done"));
    expect(r.out).toMatch(/\[scaffolding\] failed in [\d.]+ s: check:fast, check:also\n/);
  });

  describe("the gate's concurrency limit", () => {
    let dir: string;
    beforeAll(() => {
      // Each step fails where three run at once.
      const body = (me: string) =>
        `touch ${me}.on; sleep 0.5; n=$(ls *.on | wc -l); rm ${me}.on; test $n -le 2`;
      dir = gate(
        { skip, check: [["check:a", "check:b", "check:c", "check:limit"]] },
        {
          "check:a": body("a"),
          "check:b": body("b"),
          "check:c": body("c"),
          "check:limit": "echo limit=$SCAFFOLDING_TEST_TIMEOUT_MS",
        },
      );
    });
    test(
      "above one waiting process per core runs two steps at a time",
      () => {
        const loaded = run(dir, [bin("scaffolding"), "check"], {
          CHECK_LOCK: join(dir, ".lock"),
          SCAFFOLDING_LOAD: "99999",
        });
        // The per-test limit stretches by load per core, ten times at most.
        expect(loaded.code, loaded.out).toBe(0);
        expect(loaded.out).toMatch(
          /load 99999 on \d+ cores: test and catalog run one after another, the repository's steps 2 at a time/,
        );
        expect(loaded.out).toContain("limit=50000");
      },
      limit(40_000),
    );
    test(
      "at idle starts all steps together and uses the default test timeout",
      () => {
        const idle = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
        expect(idle.out).not.toContain("at a time");
        expect(idle.out).toContain("limit=5000\n");
        expect(idle.code).toBe(1);
      },
      limit(40_000),
    );
  });

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
      await until(() => fileReady(lock, (text) => text.length > 0), `the gate's lock at ${lock}`);
      await Bun.sleep(1_000);
      gateRun.kill("SIGTERM");
      const code = await gateRun.exited;
      const out = `${await new Response(gateRun.stdout).text()}${await new Response(gateRun.stderr).text()}`;
      expect(code).not.toBe(0);
      expect(out.match(/fast-said|FAIL check:fast|stopped check:slow by SIGTERM/g)).toEqual([
        "fast-said",
        "FAIL check:fast",
        "stopped check:slow by SIGTERM",
      ]);
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
      await until(() => fileReady(lock, (text) => text.length > 0), `the gate's lock at ${lock}`);
      await Bun.sleep(1_000);
      process.kill(-defined(gateRun.pid, "the gate process pid"), "SIGINT");
      await new Promise((done) => gateRun.on("close", done));
      expect(out).toContain("stopped check:slow by SIGINT");
      expect(existsSync(lock)).toBe(false);
    },
    limit(40_000),
  );

  test.each(["INT", "KILL"])("reports FAIL when only a step receives SIG%s", (signal) => {
    const step = `echo step-output; kill -s ${signal} "$$"`;
    const dir = gate({ skip, check: [step] });
    const result = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^step-output$/m);
    expect(result.out).toMatch(/^\[scaffolding\] FAIL echo step-output; kill -s .+ \d+\.\d s$/m);
    expect(result.out).not.toMatch(/^\[scaffolding\] stopped /m);
  });

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
    const r = run(dir, [bin("scaffolding"), "check"], {
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

  describe("a gate pinning brand needs retired inputs", () => {
    // A local pin: a github: one downloads brand on every install the gate runs.
    const pin = { devDependencies: { "@hackersandwizards/brand": "file:brand" } };
    const branded = (scaffolding: object, scripts: Record<string, string> = {}) => {
      const dir = gate(scaffolding, scripts, pin);
      write(dir, { "brand/package.json": '{"name":"@hackersandwizards/brand","version":"1.0.0"}' });
      return dir;
    };
    const lock = (d: string) => ({ CHECK_LOCK: join(d, ".lock") });
    const noScans = { ...skip, colours: "fixture", copies: "fixture", elements: "fixture" };
    const pinned = [
      {
        scenario: "no retired inputs",
        config: { skip: noScans },
        scripts: {},
        code: 1,
        report: /declare scaffolding\.brand\.retired/,
      },
      {
        scenario: "valid skip reason",
        config: { skip: { ...noScans, retired: "brand only in tests" } },
        scripts: {},
        code: 0,
        report: /passed/,
      },
      {
        scenario: "blank skip reason",
        config: { skip: { ...noScans, retired: " " } },
        scripts: {},
        code: 1,
        report: /declare scaffolding\.brand\.retired/,
      },
    ] as const;
    test.each(pinned)(
      "required retired scan with $scenario",
      ({ config, scripts, code, report }) => {
        const dir = branded(config, scripts);
        expect(run(dir, [bin("scaffolding"), "check"], lock(dir))).toEqual({
          code,
          out: matchingText(report),
        });
      },
    );

    test("uses the local retired check in place of the shared scan", () => {
      const dir = branded(
        { skip: noScans, check: [["check:retired", "true"]] },
        { "check:retired": "echo ran-retired" },
      );
      const result = run(dir, [bin("scaffolding"), "check"], lock(dir));
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("retired uses local check:retired");
      expect(result.out).toContain("ran-retired");
    });

    test("rejects skip.retired if the repository does not pin brand", () => {
      const unpinned = gate({ skip: { ...skip, retired: "brand only in tests" } });
      expect(run(unpinned, [bin("scaffolding"), "check"], lock(unpinned)).out).toContain(
        "scaffolding.skip names no shared step: retired",
      );
    });
  });

  test.each([
    [{ server: { command: "true" } }, [], "server"],
    [{ brand: { retired: ["dist"] } }, ["retired"], "brand.retired"],
    [
      { brand: { elements: "server" }, server: { command: "true" } },
      ["elements", "links"],
      "brand.elements",
    ],
    [{ brand: { directory: "site" } }, ["colours", "elements"], "brand.directory"],
    [{ server: { command: "true" }, linkSkips: ["/catalog"] }, ["links"], "linkSkips"],
  ] as const)("rejects unused gate configuration %#", (config, local, key) => {
    const replacements = local.map((step): string => `check:${step}`);
    const skips = Object.fromEntries(
      ["colours", "copies", "retired", "elements"]
        .filter((step) => !replacements.includes(`check:${step}`))
        .map((step) => [step, "fixture"]),
    );
    const dir = gate(
      { skip: { ...skip, ...skips }, check: replacements, ...config },
      Object.fromEntries(replacements.map((step) => [step, "true"])),
      { devDependencies: { "@hackersandwizards/brand": "file:brand" } },
    );
    write(dir, { "brand/package.json": '{"name":"@hackersandwizards/brand","version":"1.0.0"}' });
    const result = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(result.out).toContain(`scaffolding.${key} is unused`);
    expect(result.code).toBe(1);
  });

  const scans = [
    {
      name: "colours",
      command: "cd site && brand-colours",
      predicate: '[ "$#" = 0 ] && test -f paint.css',
      input: "site/paint.css",
      arg: "paint.css",
      brand: { directory: "site" },
    },
    {
      name: "copies",
      command: "brand-copies",
      predicate: '[ "$#" = 0 ] && test -f mark.svg',
      input: "mark.svg",
      arg: "mark.svg",
      brand: {},
    },
    {
      name: "retired",
      command: "brand-retired site/dist 'more output'",
      predicate: '[ "$*" = "site/dist more output" ] && [ "$#" = 2 ] && test -f "$2/page.html"',
      input: "more output/page.html",
      arg: "more output/page.html",
      brand: { retired: ["site/dist", "more output"] },
    },
    {
      name: "elements",
      command: "cd site && brand-elements",
      predicate: '[ "$#" = 0 ] && test -f brand-elements.json',
      input: "site/brand-elements.json",
      arg: "brand-elements.json",
      brand: { directory: "site" },
    },
  ];
  describe.each(
    scans.flatMap((scan) => [
      { ...scan, local: [`check:${scan.name}`], step: `check:${scan.name}`, brand: {} },
      { ...scan, local: [], step: scan.name },
    ]),
  )(
    "$step uses its pinned brand bin",
    ({ name, command, predicate, input, arg, brand, local, step }) => {
      let dir: string;
      beforeAll(() => {
        const skips = {
          ...skip,
          ...Object.fromEntries(
            ["colours", "copies", "retired", "elements"]
              .filter((other) => other !== name)
              .map((other) => [other, "fixture checks one scan"]),
          ),
        };
        dir = gate(
          { skip: skips, brand, check: local },
          { [`check:${name}`]: command },
          { devDependencies: { "@hackersandwizards/brand": "file:brand" } },
        );
        write(dir, {
          "brand/package.json": JSON.stringify({
            name: "@hackersandwizards/brand",
            bin: { [`brand-${name}`]: "check.sh" },
          }),
          "brand/check.sh": `#!/bin/sh\n${predicate} || exit 2\ngrep -q clean ${JSON.stringify(arg)}\n`,
          [input]: "bad",
        });
        chmodSync(join(dir, "brand/check.sh"), 0o755);
      });
      afterEach(() => write(dir, { [input]: "bad" }));
      const check = () =>
        run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
      test("refuses the failing scan", () => {
        const red = check();
        expect(red).toEqual({ code: 1, out: containingText(`FAIL ${step}`) });
      });
      test("accepts the passing scan", () => {
        write(dir, { [input]: "clean" });
        const green = check();
        expect(green).toEqual({ code: 0, out: containingText(`ok   ${step}`) });
      });
    },
  );

  describe("pins runs the installed slides bin", () => {
    const env = { CHECK_LOCK: join(temp(), "lock") };
    let dir: string;
    let original: string;
    beforeAll(() => {
      dir = gate({ skip }, {}, { devDependencies: { "@hackersandwizards/slides": "file:slides" } });
      write(dir, {
        "slides/package.json": JSON.stringify({
          name: "@hackersandwizards/slides",
          bin: { "slides-pins": "pins.sh" },
        }),
        "slides/pins.sh": "#!/bin/sh\necho slides-pins-fixture\ntest -f accepted\n",
      });
      chmodSync(join(dir, "slides/pins.sh"), 0o755);
      original = prepareGit(dir, ["rev-parse", "HEAD"]);
    });
    afterEach(() => {
      prepareGit(dir, ["reset", "--mixed", original]);
      rmSync(join(dir, "accepted"), { force: true });
      rmSync(join(dir, "docs/readme.md"), { force: true });
    });

    test("reports the full gate failure of the installed command", () => {
      const result = run(dir, [bin("scaffolding"), "check"], env);
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain("slides-pins-fixture");
      expect(result.out).toContain("FAIL pins");
    });

    test("selects pins even when a changed check only sees documentation", () => {
      write(dir, { accepted: "" });
      prepareGit(dir, ["add", "slides", "accepted"]);
      prepareGit(dir, ["commit", "-qm", "pin"]);
      write(dir, { "docs/readme.md": "# Fixture" });
      const result = run(dir, [bin("scaffolding"), "check", "--changed"], env);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("selected pins: runs on every changed check");
      expect(result.out).toContain("ok   pins");
    });
  });

  test("the slides repository keeps its own check:pins", () => {
    const env = { CHECK_LOCK: join(temp(), "lock") };
    const owner = gate(
      { skip, check: ["check:pins"] },
      { "check:pins": "echo own-pins-fixture" },
      { name: "@hackersandwizards/slides" },
    );
    const local = run(owner, [bin("scaffolding"), "check"], env);
    expect(local.code, local.out).toBe(0);
    expect(local.out).toContain("own-pins-fixture");
    expect(local.out).toContain("ok   check:pins");
    expect(local.out).not.toContain("ok   pins");
  });

  describe.each(["test/pages", "test/browser"])("browserTest uses %s", (folder) => {
    let dir: string;
    const env = { CHECK_LOCK: join(temp(), "lock") };
    beforeAll(() => {
      const { catalog: _, test: _test, ...enabled } = skip;
      dir = gate(
        { skip: enabled, browserTest: folder, check: ["browser-test"] },
        { build: "touch built", test: "scaffolding test" },
      );
      write(dir, {
        "node_modules/.bin/vitest": `#!/usr/bin/env bun
        const args = process.argv.slice(2);
        console.log("vitest arguments", JSON.stringify(args));
        if (args[1] !== "--exclude" && !(await Bun.file("built").exists())) process.exit(9);
        if (args[1] !== "--exclude" && await Bun.file("broken").exists()) process.exit(1);
        if (args[1] === "--exclude" && await Bun.file("broken-fast").exists()) process.exit(7);
      `,
      });
      chmodSync(join(dir, "node_modules/.bin/vitest"), 0o755);
    });

    afterEach(() => {
      for (const file of ["broken", "broken-fast", "built", "src/input.ts", "src/broken.ts"])
        rmSync(join(dir, file), { force: true });
    });

    test("passes direct unit-test arguments to the fast test suite", () => {
      const direct = run(dir, [bin("scaffolding"), "test", "unit.test.ts"], env);
      expect(direct.code, direct.out).toBe(0);
      expect(direct.out).toContain(
        JSON.stringify(["run", "--exclude", `${folder}/**`, "unit.test.ts"]),
      );
    });

    test("preserves a direct fast test run's failure exit", () => {
      write(dir, { "broken-fast": "" });
      const fastRed = run(dir, [bin("scaffolding"), "test"], env);
      expect(fastRed.out).toContain(JSON.stringify(["run", "--exclude", `${folder}/**`]));
      expect(fastRed.code).toBe(7);
    });

    test("defers the browser tests in changed checks", () => {
      write(dir, { "src/input.ts": "", "src/broken.ts": "" });
      const changed = run(dir, [bin("scaffolding"), "check", "--changed"], env);
      expect(changed.code, changed.out).toBe(0);
      expect(changed.out).toContain("deferred browser-test");
      expect(changed.out).toContain(JSON.stringify(["run", "--exclude", `${folder}/**`]));
      expect(changed.out).not.toContain(JSON.stringify(["run", folder]));
    });

    test("reports a full gate's browser failure after the build and the fast suite", () => {
      write(dir, { broken: "" });
      const full = run(dir, [bin("scaffolding"), "check"], env);
      expect(full.code).toBe(1);
      expect(
        Array.from(full.out.matchAll(/ok {3}(?:catalog|test)\b/g), (match) => match[0]).sort(),
      ).toEqual(["ok   catalog", "ok   test"]);
      expect(full.out).toContain(JSON.stringify(["run", folder]));
      expect(full.out).toContain("FAIL browser-test");
      expect(full.out).toMatch(/failed in [\d.]+ s: browser-test\n/);
    });
  });

  describe("running installed bin commands", () => {
    let dir: string;
    let manifest: string;
    const markdown = "# Note\n\nItems:\n- One\n";
    beforeAll(() => {
      dir = gate({ skip });
      const bins = join(dir, "node_modules/.bin");
      write(dir, {
        "note.md": markdown,
        "node_modules/.bin/eslint": `#!/usr/bin/env bun
        console.log("eslint", JSON.stringify(process.argv.slice(2)));
        if (await Bun.file("broken").exists()) process.exit(7);
      `,
        "node_modules/.bin/prettier": `#!/usr/bin/env bun
        console.log("prettier", JSON.stringify(process.argv.slice(2)));
        if ((await Bun.file("note.md").text()) !== ${JSON.stringify(markdown)}) process.exit(8);
      `,
      });
      prepareGit(dir, ["add", "--", "note.md"]);
      manifest = readFileSync(join(dir, "package.json"), "utf8");
      for (const command of ["eslint", "prettier"]) chmodSync(join(bins, command), 0o755);
      for (const command of ["scaffolding", "scaffolding-explore"])
        symlinkSync(bin(command), join(bins, command));
    });
    afterEach(() => {
      write(dir, { "note.md": markdown, "package.json": manifest });
      rmSync(join(dir, "broken"), { force: true });
    });
    const bun = (...args: string[]) =>
      spawnSync(process.execPath, ["run", ...args], {
        cwd: dir,
        encoding: "utf8",
      });
    test("explore resolves a bin without a manifest script", () => {
      const explore = bun("scaffolding-explore", "--help");
      expect(explore.status, explore.stderr).toBe(0);
      expect(explore.stdout).toContain("usage: scaffolding-explore");
    });

    test("fix resolves a bin and applies lint, formatting and Markdown repairs", () => {
      const green = bun("scaffolding", "fix");
      expect(green.status, green.stderr).toBe(0);
      expect(green.stdout.trim().split("\n")).toEqual([
        'eslint ["--cache","--concurrency=auto",".","--fix"]',
        'prettier ["--write","."]',
      ]);
      expect(readFileSync(join(dir, "note.md"), "utf8")).toBe("# Note\n\nItems:\n\n- One\n");
    });

    test("fix stops before formatting when ESLint fails", () => {
      write(dir, { broken: "", "note.md": markdown });
      const red = bun("scaffolding", "fix");
      expect(red.status, red.stderr).toBe(7);
      expect(red.stdout).not.toContain("prettier");
      expect(readFileSync(join(dir, "note.md"), "utf8")).toBe(markdown);
    });

    test("Bun picks a repository's own fix script", () => {
      const pkg = readPackage(dir);
      write(dir, {
        "package.json": JSON.stringify({
          ...pkg,
          scripts: { ...pkg.scripts, fix: "echo custom-fix" },
        }),
      });
      const custom = bun("fix");
      expect(custom.status, custom.stderr).toBe(0);
      expect(custom.stdout.trim()).toBe("custom-fix");
    });
  });

  test("a skipped step must name an own entry in the shared step table", () => {
    const dir = gate({ skip: { ...skip, constructor: "not a step" } });
    const result = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(result.code).toBe(1);
    expect(result.out).toContain("scaffolding.skip names no shared step: constructor");
  });

  describe("brand scans in changed checks", () => {
    let empty: ReturnType<typeof run>, outside: ReturnType<typeof run>;
    const env = { CHECK_LOCK: join(temp(), "lock") };
    beforeAll(() => {
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
      prepareGit(dir, ["add", "brand"]);
      prepareGit(dir, ["commit", "-qm", "pin"]);
      mkdirSync(join(dir, "site"));
      prepareGit(dir, ["commit", "--allow-empty", "-qm", "empty push"]);
      empty = run(dir, [bin("scaffolding"), "check", "--changed", "HEAD^..HEAD"], env);
      try {
        write(dir, { "assets/sample.png": "binary fixture" });
        outside = run(dir, [bin("scaffolding"), "check", "--changed"], env);
      } finally {
        rmSync(join(dir, "assets"), { recursive: true, force: true });
      }
    });

    test.each([
      ["an empty pushed range", () => empty],
      ["an edit outside the brand directory", () => outside],
    ] as const)("runs colour and copy scans for %s", (_, runResult) => {
      const result = runResult();
      expect(result.code, result.out).toBe(0);
      expect(
        new Set(
          result.out.match(
            /(?:selected (?:colours|copies): runs on every changed check|ok {3}(?:colours|copies))/g,
          ),
        ),
      ).toEqual(
        new Set([
          "selected colours: runs on every changed check",
          "selected copies: runs on every changed check",
          "ok   colours",
          "ok   copies",
        ]),
      );
    });

    test("defers the two built scans in an empty pushed range", () => {
      expect(empty.out).toContain("--changed: 0 paths");
      expect(empty.out).toContain("deferred retired");
      expect(empty.out).toContain("deferred elements");
    });
  });

  describe("brand scans placed after check:prepare", () => {
    let dir: string;
    let full: ReturnType<typeof run>, changed: ReturnType<typeof run>;
    beforeAll(() => {
      const { catalog: _catalog, ...skips } = skip;
      dir = gate(
        {
          skip: { ...skips, retired: "fixture", elements: "fixture" },
          check: ["check:prepare", ["colours", "copies"]],
        },
        {
          build: "mkdir -p rendered && touch rendered/page.html",
          "check:prepare": "test -f rendered/page.html && touch ready",
        },
        { devDependencies: { "@hackersandwizards/brand": "file:brand" } },
      );
      write(dir, {
        "brand/package.json": JSON.stringify({
          name: "@hackersandwizards/brand",
          bin: { "brand-colours": "scan.sh", "brand-copies": "scan.sh" },
        }),
        "brand/scan.sh": "#!/bin/sh\ntest -f ready\n",
      });
      chmodSync(join(dir, "brand/scan.sh"), 0o755);
      prepareGit(dir, ["add", "brand"]);
      prepareGit(dir, ["commit", "-qm", "pin"]);
      const env = { CHECK_LOCK: join(dir, ".lock") };
      full = run(dir, [bin("scaffolding"), "check"], env);
      // A changed gate defers the build and consumes an already rendered page.
      write(dir, { "rendered/page.html": "" });
      rmSync(join(dir, "ready"), { force: true });
      changed = run(dir, [bin("scaffolding"), "check", "--changed", "HEAD..HEAD"], env);
    });
    const steps = /ok {3}(?:check:prepare|colours|copies)(?= )/g;

    test.each([
      ["full", () => full],
      ["changed", () => changed],
    ] as const)("runs each configured scan once after prepare in the %s gate", (_, runResult) => {
      const result = runResult();
      expect(result.code, result.out).toBe(0);
      const messages = result.out.match(steps);
      assert(messages, result.out);
      const [prepare, ...scans] = messages;
      expect(prepare).toBe("ok   check:prepare");
      expect(scans.sort()).toEqual(["ok   colours", "ok   copies"]);
    });

    test("defers the catalog in the changed gate", () => {
      expect(changed.out).toContain("deferred catalog");
    });
  });

  describe.each<{
    scan: string;
    scanNames: readonly string[];
    check: readonly (string | readonly string[])[];
    scripts: Record<string, string>;
    selection: (path: string) => string;
  }>([
    {
      scan: "local",
      scanNames: ["check:colours", "check:copies"],
      check: [["check:colours", "check:copies", "check:scan"]],
      scripts: { "check:colours": "brand-colours", "check:copies": "brand-copies" },
      selection: (path: string) => `matches "${path}"`,
    },
    {
      scan: "shared",
      scanNames: ["colours", "copies"],
      check: ["check:scan"],
      scripts: {},
      selection: () => "runs on every changed check",
    },
  ])(
    "migrated brand mappings retain $scan path matches",
    ({ scanNames, check, scripts, selection }) => {
      let dir: string;
      const env = { CHECK_LOCK: join(temp(), "lock") };
      beforeAll(() => {
        const changed = Object.fromEntries(
          ["docs/**", ".claude/**", "src/content/**"].map((glob) => [
            glob,
            [...scanNames, "check:scan"],
          ]),
        );
        dir = gate(
          { skip: { ...skip, retired: "fixture", elements: "fixture" }, check, changed },
          {
            ...scripts,
            "check:scan": "true",
          },
          { devDependencies: { "@hackersandwizards/brand": "file:brand" } },
        );
        write(dir, {
          "brand/package.json": JSON.stringify({
            name: "@hackersandwizards/brand",
            bin: { "brand-colours": "pass.sh", "brand-copies": "pass.sh" },
          }),
          "brand/pass.sh": "#!/bin/sh\nexit 0\n",
        });
        chmodSync(join(dir, "brand/pass.sh"), 0o755);
        sh(dir, ["add", "brand"]);
        sh(dir, ["commit", "-qm", "pin"]);
      });

      test.each(
        ["docs/notes.md", ".claude/rules/sample.md", "src/content/entry.md"].map(
          (path) =>
            [
              path,
              [
                ...scanNames.map((step) => `selected ${step}: ${selection(path)}`),
                `selected check:scan: matches "${path}"`,
              ],
            ] as const,
        ),
      )("selects the same scans for %s", (path, selected) => {
        write(dir, { [path]: "# Fixture\n" });
        try {
          const result = run(dir, [bin("scaffolding"), "check", "--changed"], env);
          expect(result.code, result.out).toBe(0);
          const selections = result.out.match(
            /selected (?:check:)?(?:colours|copies|scan): [^\n]+/g,
          );
          assert(selections, result.out);
          expect(selections.sort()).toEqual(selected.toSorted());
          const completions = result.out.match(/ok {3}(?:check:)?(?:colours|copies|scan)\b/g);
          assert(completions, result.out);
          expect(completions.sort()).toEqual(
            [...scanNames, "check:scan"].map((name) => `ok   ${name}`).sort(),
          );
        } finally {
          rmSync(join(dir, path));
        }
      });
    },
  );

  test.each([
    ["initial", ["check:rebuild"]],
    ["preview", ["check:preview", ["retired", "check:parallel"], "check:rebuild"]],
  ])("retired reads the %s output before a later rebuild", (expected, check) => {
    const { catalog: _, ...skips } = skip;
    const dir = gate(
      {
        skip: { ...skips, colours: "fixture", copies: "fixture", elements: "fixture" },
        brand: { retired: ["dist"] },
        check,
        fullOnly: { "check:rebuild": "rebuilds the catalog" },
      },
      {
        build: "mkdir -p dist && echo initial > dist/page",
        "check:preview": "echo preview > dist/page",
        "check:parallel": "test -f dist/page",
        "check:rebuild": "echo catalog-file > dist/page",
      },
      { devDependencies: { "@hackersandwizards/brand": "file:brand" } },
    );
    write(dir, {
      "brand/package.json": JSON.stringify({
        name: "@hackersandwizards/brand",
        bin: { "brand-retired": "retired.sh" },
      }),
      "brand/retired.sh": `#!/bin/sh\ngrep -qx ${expected} "$1/page"\n`,
    });
    chmodSync(join(dir, "brand/retired.sh"), 0o755);
    const result = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("ok   retired");
    expect(readFileSync(join(dir, "dist/page"), "utf8")).toBe("catalog-file\n");
  });

  describe.each([
    {
      step: "check:links",
      serverConfig: {},
      fullOnly: { "check:links": "crawls the built site" },
      failureMessages: ["FAIL check:links", "links uses local check:links"],
    },
    {
      step: "links",
      serverConfig: { linkSkips: ["/catalog"] },
      fullOnly: {},
      failureMessages: ["FAIL links"],
    },
  ] as const)(
    "links crawls the preview build with the local skip prefixes and fails on the same broken page ($step)",
    ({ step, serverConfig, fullOnly, failureMessages }) => {
      const server = 'exec bun server.ts "$PORT"';
      const brokenPage = '<a href="/missing">missing</a><a href="/catalog/missing">skipped</a>';
      let dir: string;
      const env = { CHECK_LOCK: join(temp(), "lock") };
      beforeAll(() => {
        dir = gate(
          {
            skip,
            server: { command: server, timeout: 5, stderr: true },
            ...serverConfig,
            fullOnly: {
              "check:preview": "builds the preview",
              "check:rebuild": "rebuilds the preview",
              ...fullOnly,
            },
            check: ["check:preview", step, "check:rebuild"],
          },
          {
            "check:preview": "mkdir -p .preview && cp page.html .preview/index.html",
            "check:links": `with-server --timeout 5 --stderr '${server}' -- check-links {url} --skip /catalog`,
            "check:rebuild": "printf 'catalog-file build' > .preview/index.html",
          },
        );
        write(dir, {
          "page.html": brokenPage,
          "server.ts": `Bun.serve({ port: Number(process.argv[2]), hostname: "127.0.0.1", fetch(req) {
          const path = new URL(req.url).pathname;
          if (path === "/") return new Response(Bun.file(".preview/index.html"));
          return new Response(null, { status: path === "/found" ? 200 : 404 });
        } }); console.error("fixture server started");`,
        });
        mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
        for (const command of ["with-server", "check-links"])
          symlinkSync(bin(command), join(dir, "node_modules/.bin", command));
      });
      afterEach(() => write(dir, { "page.html": brokenPage }));

      test("defers the crawler without starting the preview server", () => {
        const result = run(dir, [bin("scaffolding"), "check", "--changed"], env);
        expect(result.code, result.out).toBe(0);
        expect(result.out).toContain(`deferred ${step}`);
        expect(result.out).not.toContain("fixture server started");
      });

      test("reports the broken link from the preview and excludes the skipped path", () => {
        const result = run(dir, [bin("scaffolding"), "check"], env);
        expect(result.code, result.out).toBe(1);
        const messages = result.out.match(
          /ok {3}check:preview|fixture server started|\/missing \(404\) <- \/|FAIL (?:check:)?links|links uses local check:links/g,
        );
        expect(messages, result.out).toEqual(
          expect.arrayContaining([
            "ok   check:preview",
            "fixture server started",
            "/missing (404) <- /",
            ...failureMessages,
          ]),
        );
        expect(messages).toHaveLength(3 + failureMessages.length);
        expect(result.out).not.toContain("/catalog/missing");
      });

      test("passes the repaired preview and runs the later rebuild", () => {
        write(dir, {
          "page.html": '<a href="/found">found</a><a href="/catalog/missing">skipped</a>',
        });
        const result = run(dir, [bin("scaffolding"), "check"], env);
        expect(result.code, result.out).toBe(0);
        expect(result.out).toContain(`ok   ${step}`);
        expect(readFileSync(join(dir, ".preview/index.html"), "utf8")).toBe("catalog-file build");
      });
    },
  );

  test("server-backed elements sees the built site through the declared base URL", () => {
    const { catalog: _, ...previewSkips } = skip;
    const dir = gate(
      {
        skip: {
          ...previewSkips,
          colours: "fixture",
          copies: "fixture",
          retired: "fixture",
        },
        brand: { directory: "site with space", elements: "server" },
        server: { command: 'exec bun server.ts "$PORT"', timeout: 5, stderr: true },
      },
      { build: "printf 'element fixture' > built.html" },
      { devDependencies: { "@hackersandwizards/brand": "file:brand" } },
    );
    write(dir, {
      "site with space/elements-input": "element configuration",
      "brand/package.json": JSON.stringify({
        name: "@hackersandwizards/brand",
        bin: { "brand-elements": "elements.ts" },
      }),
      "brand/elements.ts": `#!/usr/bin/env bun
        const [flag, address, ...extra] = process.argv.slice(2);
        const response = await fetch(address);
        if (flag !== "--base" || extra.length || await response.text() !== "element fixture" ||
          await Bun.file("elements-input").text() !== "element configuration") process.exit(1);
        console.log("elements fetched the built page");
      `,
      "server.ts": `Bun.serve({ port: Number(process.argv[2]), hostname: "127.0.0.1",
        fetch: () => new Response(Bun.file("built.html"))
      }); console.error("elements server started");`,
    });
    chmodSync(join(dir, "brand/elements.ts"), 0o755);
    const result = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(temp(), "lock") });
    expect(result.code, result.out).toBe(0);
    const messages = result.out.match(
      /ok {3}catalog|elements server started|elements fetched the built page|ok {3}elements|ok {3}links/g,
    );
    assert(messages, result.out);
    expect(messages.sort()).toEqual([
      "elements fetched the built page",
      "elements server started",
      "ok   catalog",
      "ok   elements",
    ]);
  });

  test("a test command named like an Object member runs directly", () => {
    const { test: _, ...noTest } = skip;
    const dir = gate({ skip: noTest, test: "constructor" });
    write(dir, {
      "tools/constructor": "#!/bin/sh\necho ran-constructor\n",
      constructor: "#!/bin/sh\necho ran-local-file\nexit 1\n",
    });
    for (const file of ["tools/constructor", "constructor"]) chmodSync(join(dir, file), 0o755);
    const result = run(dir, [bin("scaffolding"), "check"], {
      CHECK_LOCK: join(dir, ".lock"),
      PATH: `${join(dir, "tools")}${delimiter}${process.env.PATH}`,
    });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("ran-constructor");
  });

  test("a gate without tests goes red unless the skip gives a reason", () => {
    const { test: _, ...noTest } = skip;
    const dir = gate({ skip: noTest });
    const r = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(1);
    expect(r.out).toContain("scaffolding.test is missing");
    const named = gate({ skip: noTest, test: "echo ran-tests" });
    const ok = run(named, [bin("scaffolding"), "check"], { CHECK_LOCK: join(named, ".lock") });
    expect(ok.out).toContain("ran-tests");
    expect(ok.code).toBe(0);
  });

  test("the catalog build is a shared step: bun run build", () => {
    const { catalog: _, ...noCatalog } = skip;
    const built = gate({ skip: noCatalog }, { build: "echo ran-build" });
    const ok = run(built, [bin("scaffolding"), "check"], { CHECK_LOCK: join(built, ".lock") });
    expect(ok.out).toContain("ok   catalog");
    expect(ok.out).toContain("ran-build");
    expect(ok.code).toBe(0);
    const broken = gate({ skip: noCatalog }, { build: "exit 3" });
    const r = run(broken, [bin("scaffolding"), "check"], { CHECK_LOCK: join(broken, ".lock") });
    expect(r.out).toContain("FAIL catalog");
    expect(r.code).toBe(1);
  });

  test.each<{
    scenario: string;
    typecheck: string;
    scripts: Record<string, string>;
    code: number;
    typecheckReport: string;
  }>([
    {
      scenario: "after Astro typecheck",
      typecheck: "run check:types --pretty",
      scripts: {
        "check:types": "sleep 1 && touch tc-done && echo astro",
        build: "test -f tc-done",
      },
      code: 0,
      typecheckReport: "ok   typecheck",
    },
    {
      scenario: "beside non-Astro typecheck",
      typecheck: "tc",
      scripts: {
        tc: "for i in $(seq 60); do test -f built && exit 0; sleep 0.05; done; exit 1",
        build: "touch built",
      },
      code: 0,
      typecheckReport: "ok   typecheck",
    },
    {
      scenario: "after failing Astro typecheck",
      typecheck: "astro",
      scripts: { astro: "exit 1", build: "echo built" },
      code: 1,
      typecheckReport: "FAIL typecheck",
    },
  ])("the catalog build runs $scenario", ({ typecheck, scripts, code, typecheckReport }) => {
    const { catalog: _catalog, typecheck: _typecheck, ...rest } = skip;
    const dir = gate({ skip: rest, typecheck }, scripts);
    const result = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(result.code, result.out).toBe(code);
    expect(result.out).toContain(typecheckReport);
    expect(result.out).toContain("ok   catalog");
  });

  test("a private repository's gate leaves the confidential scan to check-confidential", () => {
    const { confidential: _, ...rest } = skip;
    const dir = gate({ skip: rest, private: true }, {});
    const r = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
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
    const r = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
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

  describe("the admin step", () => {
    const { admin: _, ...noAdmin } = skip;
    test("requires a pin or a skip reason", () => {
      const bare = gate({ skip: noAdmin });
      const unpinned = run(bare, [bin("scaffolding"), "check"], {
        CHECK_LOCK: join(bare, ".lock"),
      });
      expect(unpinned.code).toBe(1);
      expect(unpinned.out).toContain(
        "@hackersandwizards/admin is not pinned: pin it, or skip.admin with a reason",
      );
    });

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
      return run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    };
    test("reports a failure from the pinned command", () => {
      const result = pinned("exit 1");
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain("admin-check-ran");
      expect(result.out).toContain("FAIL admin");
    });

    test("passes when the pinned command succeeds", () => {
      const result = pinned("exit 0");
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("ok   admin");
    });
  });

  test.each([
    { skip, chek: [] },
    { skip: { ...skip, lnt: "t" } },
    { skip: { ...skip, lint: " " } },
  ])("rejects invalid gate configuration %#", (config) => {
    const dir = gate(config);
    expect(run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") }).code).toBe(
      1,
    );
  });

  test.each([false, 0, {}, true, ""])("rejects %j as a skip reason", (lint) => {
    const dir = gate({ skip: { ...skip, lint } });
    const r = run(dir, [bin("scaffolding"), "check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.out).toContain("scaffolding.skip.lint has no reason");
    expect(r.code).toBe(1);
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
  const both = async (cwd: string, bun: { fake: string; log: string }) => {
    const command = join(cwd, ".githooks/install");
    const first = spawn(command, [], { cwd, env: env(bun, { BUN_SLEEP: "2" }), stdio: "ignore" });
    const done = new Promise((resolve) => first.on("close", resolve));
    const second = spawnSync(command, [], { cwd, env: env(bun), encoding: "utf8" });
    await done;
    return second;
  };

  test.each([
    {
      change: "checkout with a changed lock",
      hook: "post-checkout",
      argumentsOf: (change: string[]) => change,
      log: "start locked\nend\n",
    },
    {
      change: "merge with a changed lock",
      hook: "post-merge",
      argumentsOf: () => ["0"],
      log: "start locked\nend\n",
    },
    {
      change: "checkout with an unchanged lock",
      hook: "post-checkout",
      argumentsOf: ([, current]: string[]) => [current, current, "1"],
      log: "",
    },
  ] as const)("install under the lock after a $change", ({ hook, argumentsOf, log }) => {
    const dir = consumer();
    const args = lockChange(dir);
    sh(dir, ["update-ref", "ORIG_HEAD", args[0]]);
    const bun = fakeBun();
    const result = spawnSync(join(dir, ".githooks", hook), argumentsOf(args), {
      cwd: dir,
      env: env(bun),
      encoding: "utf8",
    });
    expect(read(bun.log)).toBe(log);
    expect(`${result.stdout}${result.stderr}`).toBe("");
    expect(existsSync(join(dir, "node_modules/.check.lock"))).toBe(false);
  });

  describe("an install under a held gate lock", () => {
    let dir: string;
    let lock: string;
    const inherited: Record<string, string> = {};
    beforeAll(() => {
      dir = consumer();
      lock = join(realpathSync(dir), "node_modules/.check.lock");
      inherited.SCAFFOLDING_LOCKED = lock;
    });
    beforeEach(() => {
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      writeFileSync(
        lock,
        JSON.stringify({
          pid: process.pid,
          startedAt: Date.now(),
          command: ["bun", "x.ts", "check"],
        }),
      );
    });
    afterEach(() => rmSync(lock, { force: true }));
    const invocations: [string, Record<string, string>][] = [
      ["ordinary invocation", {}],
      ["an invocation inheriting the gate lock", inherited],
    ];
    test.each(invocations)("refuses to install after %s", (_, overrides) => {
      const bun = fakeBun();
      const install = spawnSync(join(dir, ".githooks/install"), [], {
        cwd: dir,
        env: env(bun, overrides),
        encoding: "utf8",
      });
      expect(read(bun.log)).toBe("");
      expect({ code: install.status, stdout: install.stdout }).toEqual({ code: 1, stdout: "" });
      expect(install.stderr).toContain(`pid ${process.pid} still holds`);
      expect(install.stderr).toContain(
        "[install] bun install --frozen-lockfile did not run or failed",
      );
    });
  });

  test.each([
    { hookLabel: "the installer", hook: "install", argumentsOf: () => [], code: 1 },
    { hookLabel: "the checkout", hook: "post-checkout", argumentsOf: lockChange, code: 0 },
  ] as const)(
    "a failed install is reported to stderr by $hookLabel",
    ({ hook, argumentsOf, code }) => {
      const dir = consumer();
      const bun = fakeBun();
      const result = spawnSync(join(dir, ".githooks", hook), argumentsOf(dir), {
        cwd: dir,
        env: env(bun, { BUN_EXIT: "1" }),
        encoding: "utf8",
      });
      expect({ code: result.status, stdout: result.stdout }).toEqual({ code, stdout: "" });
      expect(result.stderr).toContain("[install]");
    },
  );

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
  type HookOptions = { cwd: string; env: Record<string, string | undefined> };
  const calls = [
    [
      "post-checkout",
      (dir: string, args: string[], options: HookOptions) =>
        spawnSync(join(dir, ".githooks/post-checkout"), args, options),
    ],
    [
      "post-merge",
      (dir: string, _args: string[], options: HookOptions) =>
        spawnSync(join(dir, ".githooks/post-merge"), ["0"], options),
    ],
    [
      "session-start",
      (dir: string, args: string[], options: HookOptions) =>
        spawnSync(join(dir, ".githooks/session-start"), args, options),
    ],
  ] as const;
  const bounds = [
    ["unset", {}, "60\n"],
    ["5", { CHECK_LOCK_RUN_S: "5" }, "5\n"],
    ["empty", { CHECK_LOCK_RUN_S: "" }, "60\n"],
  ] as const;
  describe.each(calls)("%s install bound", (_, start) => {
    let dir: string;
    let bun: ReturnType<typeof fakeBun>;
    let args: string[];
    beforeAll(() => {
      dir = consumer();
      bun = fakeBun();
      args = lockChange(dir);
      prepareGit(dir, ["update-ref", "ORIG_HEAD", args[0]]);
    });
    afterEach(() => rmSync(bun.bound, { force: true }));
    test.each(bounds)("when CHECK_LOCK_RUN_S is %s", (_, override, expected) => {
      const options: HookOptions = { cwd: dir, env: env(bun) };
      delete options.env.CHECK_LOCK_RUN_S;
      Object.assign(options.env, override);
      start(dir, args, options);
      expect(read(bun.bound)).toBe(expected);
    });
  });

  describe("MCP server's start install bound", () => {
    let dir: string;
    let bun: ReturnType<typeof fakeBun>;
    beforeAll(() => {
      dir = consumer();
      bun = fakeBun();
      const args = lockChange(dir);
      prepareGit(dir, ["update-ref", "ORIG_HEAD", args[0]]);
    });
    afterEach(() => rmSync(bun.bound, { force: true }));
    test.each([
      ["unset", {}, "60\n"],
      ["5", { CHECK_LOCK_RUN_S: "5" }, "5\n"],
    ] as const)("when CHECK_LOCK_RUN_S is %s", (_, override, expected) => {
      const options: HookOptions = { cwd: dir, env: env(bun) };
      delete options.env.CHECK_LOCK_RUN_S;
      Object.assign(options.env, override);
      mcpStart(dir, options);
      expect(read(bun.bound)).toBe(expected);
    });
  });

  // The MCP server's start and the SessionStart hook install at the same moment.
  test("two first installs at once wait for each other, the second without a word", async () => {
    const dir = consumer();
    const bun = fakeBun();
    const second = await both(dir, bun);
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
    await both(dir, bun);
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
      const lock = join(dir, "node_modules/.check.lock");
      await until(
        () => fileReady(lock, (value) => value.includes('"group"')),
        `the install process group at ${lock}`,
        {
          timeoutMs: 200 * 50,
        },
      );
      expect(read(lock)).toContain('"group"');
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
    prepareGit(dir, ["worktree", "remove", tree]);
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
    prepareCommand(dir, ["git", "switch", "-q", "--orphan", "unborn"], env(bun));
    const returned = spawnSync("git", ["switch", "-q", branch], { cwd: dir, env: env(bun) });
    expect(returned.status, returned.stderr.toString()).toBe(0);
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
  // A clone of an origin one commit ahead, its install recording the commit it sees.
  const clone = () => {
    const origin = repo({ "a.txt": "1\n", "b.txt": "original\n" });
    const dir = temp();
    spawnSync("git", ["clone", "-q", origin, dir]);
    cpSync(join(import.meta.dirname, "..", "template/.githooks"), join(dir, ".githooks"), {
      recursive: true,
    });
    write(origin, { "a.txt": "2\n" });
    sh(origin, ["commit", "-q", "-am", "two"]);
    const fake = temp();
    // The fetch's timer uses the real Bun.
    writeFileSync(
      join(fake, "bun"),
      `#!/bin/sh\nif [ "$1" = install ]; then\n  git rev-parse HEAD >.git/install-head\n  exit $?\nfi\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
    return { dir, origin, path: `${fake}:${process.env.PATH}` };
  };
  // dash, Debian's and Ubuntu's /bin/sh, makes no process group for `set -m` without a terminal.
  const shells = ["/bin/sh", "/bin/dash"].filter((shell) => existsSync(shell));
  const start = (dir: string, env: Record<string, string>, shell = "/bin/sh") =>
    spawnSync(shell, [hook], {
      cwd: dir,
      env: { ...process.env, CLAUDE_CODE_REMOTE: "false", ...env },
      encoding: "utf8",
    });
  const head = (dir: string) => sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
  const notMerged =
    "origin/main is 1 commits ahead of HEAD and was not merged: merge it per git.md before work\n";

  describe("a clean checkout and subsequent SessionStart calls", () => {
    let checkout: ReturnType<typeof clone>;
    let entered: ReturnType<typeof start>;
    beforeAll(() => {
      checkout = clone();
      entered = start(checkout.dir, { PATH: checkout.path });
    });
    test("silently fast-forwards before installing", () => {
      expect(entered.stdout).toBe("");
      expect(head(checkout.dir)).toBe(head(checkout.origin));
      expect(readFileSync(join(checkout.dir, ".git/install-head"), "utf8").trim()).toBe(
        head(checkout.origin),
      );
    });
    // Malformed and zero bounds both fall back to the default.
    test.each([
      ["the default", {}],
      ["an invalid bound", { SCAFFOLDING_FETCH_WAIT_S: "20s" }],
      ["zero", { SCAFFOLDING_FETCH_WAIT_S: "0" }],
    ] as [string, Record<string, string>][])("starts silently with %s", (_, settings) => {
      expect(start(checkout.dir, { PATH: checkout.path, ...settings }).stdout).toBe("");
    });
  });

  test("reports a diverged main and leaves its tip in place", () => {
    const { dir, path } = clone();
    write(dir, { "b.txt": "local commit\n" });
    prepareGit(dir, ["commit", "-qam", "local"]);
    const before = head(dir);
    expect(start(dir, { PATH: path }).stdout).toBe(notMerged);
    expect(head(dir)).toBe(before);
  });

  test("fast-forwards silently and preserves an unrelated tracked edit", () => {
    const { dir, origin, path } = clone();
    write(dir, { "b.txt": "another session's\n" });
    expect(start(dir, { PATH: path }).stdout).toBe("");
    expect(head(dir)).toBe(head(origin));
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("another session's\n");
  });

  test.each(["false", "true"])(
    "reports and preserves a conflicting tracked edit and the tip with merge.autostash=%s",
    (autostash) => {
      const { dir, path } = clone();
      prepareGit(dir, ["config", "merge.autostash", autostash]);
      const before = head(dir);
      write(dir, { "a.txt": "another session's\n" });
      expect(start(dir, { PATH: path }).stdout).toBe(notMerged);
      expect(head(dir)).toBe(before);
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("another session's\n");
    },
  );

  test("a clone of one other branch still learns how far main is ahead", () => {
    const { dir, origin, path } = clone();
    sh(origin, ["branch", "-q", "work", "HEAD~1"]);
    const single = temp();
    spawnSync("git", ["clone", "-q", "--single-branch", "--branch", "work", origin, single]);
    cpSync(join(dir, ".githooks"), join(single, ".githooks"), { recursive: true });
    const before = head(single);
    expect(start(single, { PATH: path }).stdout).toBe(notMerged);
    expect(sh(single, ["branch", "--show-current"]).stdout.toString()).toBe("work\n");
    expect(head(single)).toBe(before);
  });

  test("a cloud session switches to main and fast-forwards", () => {
    const { dir, origin, path } = clone();
    sh(dir, ["switch", "-q", "-c", "work"]);
    const r = start(dir, { PATH: path, CLAUDE_CODE_REMOTE: "true" });
    expect(r.stdout).toBe("");
    expect(sh(dir, ["branch", "--show-current"]).stdout.toString()).toBe("main\n");
    expect(head(dir)).toBe(head(origin));
  });

  describe("a cloud session in a clone of one other branch", () => {
    let single: string;
    let origin: string;
    let cloud: Record<string, string>;
    beforeAll(() => {
      const fixture = clone();
      origin = fixture.origin;
      cloud = { PATH: fixture.path, CLAUDE_CODE_REMOTE: "true" };
      prepareGit(origin, ["branch", "-q", "work", "HEAD~1"]);
      single = temp();
      prepareGit(single, ["clone", "-q", "--single-branch", "--branch", "work", origin, "."]);
      cpSync(join(fixture.dir, ".githooks"), join(single, ".githooks"), { recursive: true });
    });

    test("switches to main and configures its upstream", () => {
      const first = temp();
      cpSync(single, first, { recursive: true });
      expect(start(first, cloud).stdout).toBe("");
      expect(prepareGit(first, ["branch", "--show-current"])).toBe("main");
      expect(head(first)).toBe(head(origin));
      expect(prepareGit(first, ["rev-parse", "--abbrev-ref", "main@{upstream}"])).toBe(
        "origin/main",
      );
    });

    test("keeps a single fetch refspec when main has to be created again", () => {
      const restart = temp();
      cpSync(single, restart, { recursive: true });
      // The prerequisite start discovers main. The second starts without the local branch again.
      const entered = start(restart, cloud);
      requireFixtureSuccess(`/bin/sh ${hook}`, entered.status, entered.stdout + entered.stderr);
      prepareGit(restart, ["switch", "-q", "work"]);
      prepareGit(restart, ["branch", "-q", "-D", "main"]);
      expect(start(restart, cloud).stdout).toBe("");
      expect(prepareGit(restart, ["config", "--get-all", "remote.origin.fetch"])).toBe(
        "+refs/heads/work:refs/remotes/origin/work\n+refs/heads/main:refs/remotes/origin/main",
      );
    });
  });

  // setTimeout ran a delay past 2^31 - 1 ms at once, and the fetch was stopped as it began.
  test("a bound past what setTimeout takes still waits for the fetch", async () => {
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
    await until(
      () => fileReady(pid, (value) => /^\d+\n$/.test(value)),
      `the fetch process PID at ${pid}`,
      {
        intervalMs: 100,
      },
    );
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
      expect(() => process.kill(sleeper, 0)).toThrow(/ESRCH/);
    },
  );
});

describe("shared eslint config", () => {
  // The untyped rules alone, as check-staged runs them: these fixtures sit in no tsconfig.
  const untyped = { ...process.env, SCAFFOLDING_LINT_UNTYPED: "1" };

  const lintFixture = (fixtureDir?: string) => {
    const dir = repo(
      {
        ".oxlintrc.json": JSON.stringify(oxlintTemplate),
        "eslint.config.js":
          'export { default } from "@hackersandwizards/scaffolding/eslint/astro";\n',
        "package.json": '{"type":"module"}',
        "tsconfig.json": '{"include":["*.ts"]}',
        "value.ts":
          "export const value = 1;\nexport const other = 2;\nexport type Value = number;\n",
      },
      true,
      fixtureDir,
    );
    install(dir);
    const lib = join(import.meta.dirname, "../lib");
    const oxlint = () =>
      spawnSync(process.execPath, ["--no-env-file", join(lib, "oxlint.ts")], {
        cwd: dir,
        encoding: "utf8",
      });
    const eslint = (file: string) =>
      spawnSync(
        process.execPath,
        [
          "--bun",
          join(import.meta.dirname, "../node_modules/.bin/eslint"),
          file,
          "-f",
          join(lib, "eslint-formatter.ts"),
        ],
        { cwd: dir, encoding: "utf8", env: untyped },
      );
    return { dir, oxlint, eslint };
  };
  const empty = "try { return work(); } catch {}";
  const commented = "try { return work(); } catch { /* explanation */ }";
  const recovery = "try { return work(); } catch { return 0; }";
  const wrap = (body: string) => `export function check(work = () => 1) { ${body} }\n`;

  test("lint directive comments give eight findings and one guide", () => {
    const { dir, eslint } = lintFixture();
    const directives = ["eslint-disable", "eslint-enable", "oxlint-disable", "oxlint-enable"];
    write(dir, {
      "a.js":
        directives
          .map(
            (directive) => `// ${directive}-next-line no-undef\n/* ${directive}-line no-undef */`,
          )
          .join("\n") + "\nexport {};\n",
    });
    const red = eslint("a.js");
    expect(red.status, red.stdout + red.stderr).toBe(1);
    expect(red.stdout.match(/scaffolding\/no-lint-disable/g)).toHaveLength(8);
    expectGuideAfter(red.stdout, "no-lint-disable", "scaffolding/no-lint-disable");
    write(dir, {
      "a.js":
        'export const text = "eslint-disable eslint-enable oxlint-disable oxlint-enable";\nexport const template = `eslint-disable eslint-enable oxlint-disable oxlint-enable`;\n',
    });
    const green = eslint("a.js");
    expect(green.status, green.stdout + green.stderr).toBe(0);
    expect(green.stdout).toBe("");
  });

  test("the first eslint-disable comment cannot suppress the rule", () => {
    const { dir, eslint } = lintFixture();
    write(dir, { "a.js": "/* eslint-disable */\nexport {};\n" });
    const result = eslint("a.js");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout.match(/scaffolding\/no-lint-disable/g)).toHaveLength(1);
    expectGuideAfter(result.stdout, "no-lint-disable", "scaffolding/no-lint-disable");
  });

  test.each([
    ["frontmatter", "---\n// oxlint-disable no-undef\n---\n<p>Ready</p>\n"],
    ["template", "<!-- eslint-disable -->\n<p>Ready</p>\n"],
    ["script", "<script>\n// eslint-disable\n</script>\n"],
    ["inline script", "<script is:inline>\n// eslint-disable\n</script>\n"],
  ])("a lint directive in Astro %s gives one finding", (_region, content) => {
    const { dir, eslint } = lintFixture();
    write(dir, { "a.astro": content });
    const result = eslint("a.astro");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout.match(/scaffolding\/no-lint-disable/g)).toHaveLength(1);
    expectGuideAfter(result.stdout, "no-lint-disable", "scaffolding/no-lint-disable");
  });

  test("a passing Oxlint command starts no guide collection subprocess", () => {
    const dir = repo({
      "node_modules/oxlint/package.json":
        '{"name":"oxlint","exports":{"./package.json":"./package.json"}}',
      "node_modules/oxlint/bin/oxlint":
        'import { appendFileSync } from "node:fs";\nappendFileSync("starts.log", process.argv.includes("json") ? "json\\n" : "lint\\n");\n',
      "run.ts":
        'import { runOxlintWithGuides } from "./lib/oxlint.ts";\nprocess.exitCode = runOxlintWithGuides(process.cwd(), ["."]);\n',
    });
    const root = join(import.meta.dirname, "..");
    mkdirSync(join(dir, "lib"));
    copyFileSync(join(root, "lib/oxlint.ts"), join(dir, "lib/oxlint.ts"));
    for (const file of ["guides.ts", "lint-rule-overlaps.ts", "oxlint-restrictions.ts", "repo.ts"])
      symlinkSync(join(root, "lib", file), join(dir, "lib", file));
    symlinkSync(join(root, "template"), join(dir, "template"), "dir");
    const result = spawnSync(process.execPath, ["--no-env-file", "run.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(dir, "starts.log"), "utf8")).toBe("lint\n");
  });

  test("Oxlint prints one guide for a diagnostic stream larger than one megabyte", () => {
    const findings = 4000;
    // The test glob keeps max-lines from adding a 4,001st diagnostic and a second guide.
    const probe = "probe.test.js";
    const dir = repo({
      ".oxlintrc.json": JSON.stringify(oxlintTemplate),
      [probe]: "debugger;\n".repeat(findings),
    });
    install(dir);
    const output = join(dir, "oxlint.log");
    const fd = openSync(output, "wx");
    const result = (() => {
      try {
        return spawnSync(
          process.execPath,
          ["--no-env-file", join(import.meta.dirname, "../lib/oxlint.ts")],
          {
            cwd: dir,
            encoding: "utf8",
            stdio: ["ignore", fd, "pipe"],
          },
        );
      } finally {
        closeSync(fd);
      }
    })();
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/^\[oxlint\]/m);
    expectGuideAfter(readFileSync(output, "utf8"), "no-debugger", "eslint(no-debugger)");

    const json = runOxlint(dir, ["-f", "json", probe], true);
    expect(Buffer.byteLength(json.stdout)).toBeGreaterThan(1024 * 1024);
    expect(jsonObject(json.stdout).diagnostics).toHaveLength(findings);
    expect(readdirSync(join(dir, "node_modules/.cache/scaffolding"))).toEqual([]);
  });

  test("an Oxlint capture clears abandoned output and keeps a fresh capture", () => {
    const { dir } = lintFixture();
    const output = join(dir, "node_modules/.cache/scaffolding");
    const stale = join(output, "oxlint-output-abandoned");
    const fresh = join(output, "oxlint-output-running");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh);
    const old = new Date(Date.now() - 3_600_000 - 60_000);
    utimesSync(stale, old, old);
    const result = runOxlint(dir, ["--debug=files", "."], true);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(output)).toEqual(["oxlint-output-running"]);
  });

  test("Vue and Svelte are the native-only files among the shared lint inputs", async () => {
    const { dir } = lintFixture();
    const files = {
      ".claude/task.js": "export {};",
      ".githooks/task.js": "export {};",
      ".agents/task.js": "export {};",
      "nested/.claude/task.js": "export {};",
      "nested/.githooks/task.js": "export {};",
      "nested/.agents/task.js": "export {};",
      "a.astro": "<script>console.log(1);</script>",
      "a.vue": "<script>console.log(1);</script>",
      "a.svelte": "<script>console.log(1);</script>",
      "a.html": "<script>console.log(1);</script>",
      ...Object.fromEntries(
        ["js", "cjs", "mjs", "jsx", "ts", "cts", "mts", "tsx"].map((ext) => [
          `a.${ext}`,
          "export {};",
        ]),
      ),
    };
    write(dir, files);
    const eslint = new ESLint({ cwd: dir });
    const native = oxlintFiles(dir).sort();
    const nativeOnly = ["a.svelte", "a.vue"];
    expect(native).toEqual(expect.arrayContaining(nativeOnly));
    const active = await Promise.all(
      native.map(async (file) =>
        activeSeverity(
          member(await eslint.calculateConfigForFile(file), "rules", "scaffolding/no-empty-catch"),
        ),
      ),
    );
    expect(native.filter((_, index) => !active[index])).toEqual(nativeOnly);
  });

  test.each([
    { rule: "no-empty", file: "a.js", hit: wrap(empty), pass: wrap(recovery), occurrences: 2 },
    {
      rule: "eqeqeq",
      file: "a.js",
      hit: "export const same = (a, b) => a == b;\n",
      pass: "export const same = (a, b) => a === b || a == null;\n",
      occurrences: 2,
    },
    {
      rule: "no-duplicate-imports",
      file: "a.ts",
      hit: 'import { value } from "./value";\nimport { other } from "./value";\nexport const n = value + other;\n',
      pass: 'import { value } from "./value";\nimport type { Value } from "./value";\nexport const n: Value = value;\n',
      occurrences: 2,
    },
    {
      rule: "no-warning-comments",
      file: "a.js",
      hit: "// this has a todo in it\n// FIXME: revise\nexport {};\n",
      pass: "// explanation\nexport {};\n",
      occurrences: 3,
    },
    {
      rule: "no-var",
      file: "a.js",
      hit: "var n = 1;\nconsole.log(n);\n",
      pass: "const n = 1;\nconsole.log(n);\n",
      occurrences: 2,
    },
    {
      rule: "no-var",
      file: "a.mjs",
      hit: "var n = 1;\nconsole.log(n);\n",
      pass: "const n = 1;\nconsole.log(n);\n",
      occurrences: 2,
    },
    {
      rule: "prefer-const",
      file: "a.js",
      hit: "let n = 1;\nconsole.log(n);\n",
      pass: "const n = 1;\nconsole.log(n);\n",
      occurrences: 2,
    },
    {
      rule: "prefer-const",
      file: "a.mjs",
      hit: "let n = 1;\nconsole.log(n);\n",
      pass: "const n = 1;\nconsole.log(n);\n",
      occurrences: 2,
    },
    {
      rule: "no-inferrable-types",
      file: "a.ts",
      hit: "const n: number = 1;\nconsole.log(n);\n",
      pass: "const n = 1;\nconsole.log(n);\n",
      occurrences: 2,
    },
  ])("Oxlint reports and guides $rule in $file", ({ rule, file, hit, pass, occurrences }) => {
    const { dir, oxlint } = lintFixture();
    write(dir, { [file]: hit });
    const red = oxlint();
    expect(red.status, red.stdout + red.stderr).toBe(1);
    const findings = red.stdout.split("[guide]")[0];
    expect(findings.split(`(${rule})`)).toHaveLength(occurrences);
    expectGuide(red.stdout, rule);
    write(dir, { [file]: pass });
    const green = oxlint();
    expect(green.status, green.stdout + green.stderr).toBe(0);
    expect(green.stdout).not.toContain("[guide]");
  });

  test.each([
    {
      shape: "clause",
      hit: wrap(commented),
      pass: wrap(recovery) + "function control() { try { return 1; } catch {} }\ncontrol();\n",
      occurrences: 1,
      wording: "This catch discards",
    },
    {
      shape: "callback",
      hit: "Promise.resolve(1).catch(() => {});\nPromise.resolve(1).catch(function () { /* note */ });\n",
      pass: "const handle = console.error;\nPromise.resolve(1).catch(() => undefined);\nPromise.resolve(1).catch(handle);\nPromise.resolve(1).catch((error) => { console.error(error); });\n",
      occurrences: 2,
      wording: "This .catch() callback discards",
    },
  ])("ESLint reports and guides the empty catch $shape", ({ hit, pass, occurrences, wording }) => {
    const { dir, eslint } = lintFixture();
    write(dir, { "a.js": hit });
    const red = eslint("a.js");
    expect(red.status, red.stdout + red.stderr).toBe(1);
    expect(red.stdout.match(/scaffolding\/no-empty-catch/g)).toHaveLength(occurrences);
    expect(red.stdout).toContain(wording);
    expectGuide(red.stdout, "no-empty-catch");
    write(dir, { "a.js": pass });
    const fallback = eslint("a.js");
    expect(fallback.status, fallback.stdout + fallback.stderr).toBe(1);
    expect({
      summary: fallback.stdout.match(/✖ \d+ problems? \(\d+ errors?, \d+ warnings?\)/)?.[0],
      guides: fallback.stdout.match(/^\[guide\] [^:]+/gm),
    }).toEqual({
      summary: "✖ 1 problem (1 error, 0 warnings)",
      guides: ["[guide] no-catch-fallback"],
    });
  });

  test.each([
    {
      shape: "clauses with omitted bindings",
      file: "a.js",
      hit:
        wrap("try { return work(); } catch { if (work) return 0; }") +
        "export function stop(work) { try { work(); } catch { return; } }\n",
      pass:
        wrap(
          "try { return work(); } catch (error) { if (error instanceof SyntaxError) return 0; throw error; }",
        ) +
        "export function nested(work) { try { work(); } catch { const next = () => { return 0; }; next(); } }\n",
      occurrences: 2,
      wording: "This catch can return without inspecting",
    },
    {
      shape: "callbacks with expression and block returns",
      file: "a.test.ts",
      hit: 'Promise.resolve(1).catch(() => 0);\nPromise.resolve(1)["catch"](function (_error, fallback) { if (Date.now()) return fallback; });\n',
      pass:
        "Promise.resolve(1).catch((error) => String(error));\n" +
        "Promise.resolve(1).catch((error, fallback = String(error)) => fallback);\n" +
        "export class OtherCatch { #catch(handle) { return handle(); } run() { return this.#catch(() => 0); } }\n" +
        'Promise.resolve(1).catch(({ code }) => { if (code === "ENOENT") return 0; throw new Error(code); });\n' +
        "Promise.resolve(1).catch(() => { const next = () => { return 0; }; next(); });\n",
      occurrences: 2,
      wording: "This .catch() callback can return without inspecting",
    },
    ...[
      ["Astro script", "<script>\n", "</script>\n"],
      [
        "Astro inline script",
        "<script is:inline>\n",
        "</script>\n",
        "catch (_error) { if (work) { const _error = 0; return _error; } }",
      ],
      ["Astro frontmatter", "---\n", "---\n<p>ready</p>\n"],
      ["Astro template expression", "{(() => {", "})()}\n"],
    ].map(([shape, open, close, handler = "catch { return 0; }"]) => ({
      shape,
      file: "a.astro",
      hit:
        open +
        `function checked(work = () => 1) { try { return work(); } ${handler} }\nchecked();\n` +
        close,
      pass:
        open +
        "function checked(work = () => 1) { try { return work(); } catch (error) { if (error instanceof SyntaxError) return 0; throw error; } }\nchecked();\n" +
        close,
      occurrences: 1,
      wording: "This catch can return without inspecting",
    })),
  ])(
    "ESLint refuses ignored catch fallbacks in $shape",
    ({ file, hit, pass, occurrences, wording }) => {
      using fixture = testDirectory();
      const { dir, eslint } = lintFixture(fixture.folder);
      write(dir, { [file]: hit });
      const red = eslint(file);
      expect(
        {
          findings: red.stdout.match(/scaffolding\/no-catch-fallback/g)?.length,
          summary: red.stdout.match(/✖ (\d+) problems?/)?.[1],
        },
        red.stdout + red.stderr,
      ).toEqual({ findings: occurrences, summary: String(occurrences) });
      expect(red.status, red.stdout + red.stderr).toBe(1);
      expect(red.stdout).toContain(wording);
      expectGuide(red.stdout, "no-catch-fallback");
      write(dir, { [file]: pass });
      const green = eslint(file);
      expect(green.status, green.stdout + green.stderr).toBe(0);
      expect(green.stdout).not.toContain("[guide]");
    },
  );

  test.each([
    ["script", "<script>\n", "</script>\n"],
    ["script is:inline", "<script is:inline>\n", "</script>\n"],
    ["frontmatter", "---\n", "---\n<p>ready</p>\n"],
  ])("Astro %s catches are owned once across both linters", (_, open, close) => {
    const { dir, oxlint, eslint } = lintFixture();
    const component = (body: string) =>
      `${open}function check(work = () => 1) { ${body} }\ncheck();\n${close}`;
    write(dir, {
      "empty.astro": component(empty),
      "commented.astro": component(commented),
      "recovery.astro": component(recovery),
    });
    const native = oxlint();
    const fallback = eslint(".");
    const reported = (out: string) =>
      out.split("[guide]")[0].match(/\b(?:empty|commented|recovery)\.astro\b/g);
    expect(native.status, native.stdout + native.stderr).toBe(1);
    expect(fallback.status, fallback.stdout + fallback.stderr).toBe(1);
    expect(reported(native.stdout)).toEqual(["empty.astro"]);
    expect(reported(fallback.stdout)).toEqual(["commented.astro", "recovery.astro"]);
    expectGuide(native.stdout, "no-empty");
    expectGuide(fallback.stdout, "no-empty-catch", "no-catch-fallback");
  });

  test("Astro template expressions get the small rules and both catch checks", () => {
    const { dir, oxlint, eslint } = lintFixture();
    const frontmatter = "---\nconst { a, b } = Astro.props;\n---\n";
    write(dir, {
      "a.astro":
        frontmatter +
        `{a == b ? 1 : 2}
{(() => { var x = 1; let y = 2; /* this has a todo in it */ return x + y; })()}
{(() => { try { return a; } catch {} })()}
{(() => { try { return a; } catch { /* description */ } })()}\n`,
    });
    const red = eslint("a.astro");
    expect(red.status, red.stdout + red.stderr).toBe(1);
    const headings = Array.from(
      red.stdout.matchAll(/^\[guide\] ([^:]+):/gm),
      ([, rule]) => rule,
    ).sort();
    expect(headings).toEqual([
      "eqeqeq",
      "no-empty",
      "no-empty-catch",
      "no-var",
      "no-warning-comments",
      "prefer-const",
    ]);
    expect(oxlint().status).toBe(0);
    write(dir, {
      "a.astro":
        frontmatter +
        `{a == null ? 1 : a === b ? 2 : 3}
{(() => { const x = 1; /* explanation */ return x; })()}
{(() => { try { return a; } catch { return 0; } })()}\n`,
    });
    const fallback = eslint("a.astro");
    expect(fallback.status, fallback.stdout + fallback.stderr).toBe(1);
    expect({
      summary: fallback.stdout.match(/✖ \d+ problems? \(\d+ errors?, \d+ warnings?\)/)?.[0],
      guides: fallback.stdout.match(/^\[guide\] [^:]+/gm),
    }).toEqual({
      summary: "✖ 1 problem (1 error, 0 warnings)",
      guides: ["[guide] no-catch-fallback"],
    });
  });

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
    expect([...new Set(findings.map(([file]) => file))].sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/unused.ts",
    ]);
    const eslint = join(import.meta.dirname, "..", "node_modules", ".bin", "eslint");
    expect(spawnSync(eslint, ["."], { cwd: dir }).status).toBe(0);
    write(dir, { "outside.ts": "export const a = 1;\n" });
    const outside = check();
    expect({ status: outside.status, stderr: outside.stderr }).toEqual({
      status: 1,
      stderr: containingText("outside.ts: is outside tsconfig.json"),
    });
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
    expect(new Set(fallback.stdout.match(/no-useless-assignment|no-redeclare/g))).toEqual(
      new Set(["no-useless-assignment"]),
    );
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
    const checkout = realpathSync(dir);
    const namedFiles = Array.from(r.stdout.matchAll(/^\/[^\n]+\.(?:ts|mjs|js)$/gm), ([file]) =>
      relative(checkout, realpathSync(file)),
    );
    expect(namedFiles.sort()).toEqual([
      "a.test.ts",
      "c.spec.ts",
      "e2e/e.js",
      "f.test.ts",
      "tests/d.ts",
    ]);
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

  describe("Astro template and script diagnostics", () => {
    let dir: string;
    beforeAll(() => {
      dir = repo({
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
    });
    const eslint = join(import.meta.dirname, "..", "node_modules", "eslint", "bin", "eslint.js");
    test("Oxlint owns lexical diagnostics in Astro scripts and frontmatter", () => {
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
    });

    describe.each([
      {
        mode: "typed",
        env: { ...process.env, SCAFFOLDING_LINT_UNTYPED: "" },
        typed: true,
        floating: ["14:3 ", "15:3 "],
        unsafeCalls: ["19:3 "],
      },
      { mode: "untyped", env: untyped, typed: false, floating: [], unsafeCalls: [] },
    ] as const)("ESLint $mode Astro diagnostics", ({ mode, env, typed, floating, unsafeCalls }) => {
      let result: ReturnType<typeof run>;
      let stderr: string;
      beforeAll(() => {
        const lint = spawnSync(process.execPath, ["--bun", eslint, "src/probe.astro"], {
          cwd: dir,
          encoding: "utf8",
          env,
        });
        assert(lint.status !== null, lint.stderr);
        result = { code: lint.status, out: lint.stdout };
        stderr = lint.stderr;
      });
      const positions = (rule: string) =>
        Array.from(
          result.out.matchAll(new RegExp(`(\\d+:\\d+ ).*${rule}`, "g")),
          ([, position]) => position,
        );

      test(`maps ${mode} template diagnostics to their Astro positions`, () => {
        expect(result.code, result.out).toBe(1);
        expect(stderr).toBe("");
        expect(positions("no-debugger")).toEqual([matchingText(/^6:\d+ /)]);
        expect(positions("no-irregular-whitespace")).toEqual(["26:39 ", "27:34 "]);
        expect(result.out).not.toMatch(/(?:3:1|13:3) .*no-debugger/);
      });
      test(`reports ${mode} promise diagnostics only as configured`, () => {
        expect(result.out.includes("no-floating-promises")).toBe(typed);
        expect(positions("@typescript-eslint/no-floating-promises")).toEqual(floating);
      });
      test(`reports ${mode} unsafe calls without false positives in other regions`, () => {
        expect(positions("@typescript-eslint/no-unsafe-call")).toEqual(unsafeCalls);
        expect(result.out).not.toContain("no-undef");
        expect(result.out).not.toMatch(/^\s+(?:8|18|23):\d+ .*no-unsafe/m);
      });
    });
  });

  const jsdoc = "/** @param {HTMLElement} stage */\n";
  const unsafeCall = "@typescript-eslint/no-unsafe-call";
  const unsafeAccess = "@typescript-eslint/no-unsafe-member-access";
  test.each([
    {
      script: "inline with JSDoc",
      attrs: " is:inline",
      doc: jsdoc,
      parameter: "stage",
      member: "style.setProperty",
      rules: [],
    },
    {
      script: "unprocessed by attribute",
      attrs: ' type="module"',
      doc: jsdoc,
      parameter: "stage",
      member: "style.setProperty",
      rules: [],
    },
    {
      script: "inline without JSDoc",
      attrs: " is:inline",
      doc: "",
      parameter: "stage",
      member: "style.setProperty",
      rules: [unsafeCall, unsafeAccess],
    },
    {
      script: "inline with an unknown member",
      attrs: " is:inline",
      doc: jsdoc,
      parameter: "stage",
      member: "unknownMember",
      rules: [unsafeCall],
    },
    {
      script: "processed with a type",
      attrs: "",
      doc: "",
      parameter: "stage: HTMLElement",
      member: "style.setProperty",
      rules: [],
    },
    {
      script: "processed without a type",
      attrs: "",
      doc: "",
      parameter: "stage",
      member: "style.setProperty",
      rules: [unsafeCall, unsafeAccess],
    },
    {
      script: "processed by src alone",
      attrs: ' src="./helper.js"',
      doc: jsdoc,
      parameter: "stage",
      member: "style.setProperty",
      rules: [unsafeCall, unsafeAccess],
    },
  ])(
    "typed Astro lint checks a helper in a script $script",
    async ({ attrs, doc, parameter, member, rules }) => {
      const { dir } = lintFixture();
      write(dir, {
        "tsconfig.json": '{"compilerOptions":{"strict":true,"allowJs":false},"include":["*.ts"]}',
        "helper.astro": `<script${attrs}>
${doc}function fit(${parameter}) {
  stage.${member}("width", "100px");
}
fit(document.body);
</script>\n`,
      });
      const lint = new ESLint({ cwd: dir });
      const [result] = await lint.lintFiles(["helper.astro"]);
      expect(result.messages.map(({ ruleId }) => ruleId)).toEqual(rules);
    },
  );

  test("an inline Astro script keeps its existing ESLint and Oxlint rules", async () => {
    const { dir, oxlint } = lintFixture();
    write(dir, {
      "rules.astro": `<script is:inline>
      const spare = 1;
      console.log(missing);
      if (document.title == "ready") {}
      try { console.log(document.title); } catch { /* explanation */ }
      </script>\n`,
    });
    const lint = new ESLint({ cwd: dir });
    const [result] = await lint.lintFiles(["rules.astro"]);
    expect(result.messages.map(({ ruleId }) => ruleId)).toEqual([
      "@typescript-eslint/no-unused-vars",
      "no-undef",
      "scaffolding/no-empty-catch",
    ]);
    const native = oxlint();
    expect(native.status, native.stderr + native.stdout).toBe(1);
    expect(native.stdout.split("[guide]")[0]).toContain("eslint(eqeqeq)");
    expect(native.stdout.split("[guide]")[0]).toContain("eslint(no-empty)");
  });

  test("adding is:inline rechecks an unchanged script body as JavaScript", async () => {
    const { dir } = lintFixture();
    const lint = new ESLint({ cwd: dir });
    const body = `${jsdoc}function fit(stage) { stage.style.setProperty("width", "100px"); }
fit(document.body);\n`;
    const filePath = join(dir, "helper.astro");
    const [processed] = await lint.lintText(`<script>\n${body}</script>\n`, { filePath });
    expect(processed.messages.map(({ ruleId }) => ruleId)).toEqual([unsafeCall, unsafeAccess]);
    const [inline] = await lint.lintText(`<script is:inline>\n${body}</script>\n`, { filePath });
    expect(inline.messages).toEqual([]);
  });

  describe("Astro frontmatter project types", () => {
    let dir: string;
    beforeAll(() => {
      dir = repo({
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
    });
    const eslint = join(import.meta.dirname, "../node_modules/eslint/bin/eslint.js");
    const floating = "@typescript-eslint/no-floating-promises";
    test.each([
      {
        mode: "typed",
        env: { ...process.env, SCAFFOLDING_LINT_UNTYPED: "" },
        status: 1,
        expected: [
          ["app/Explicit.astro", floating, 3, 21, 3, 40],
          ["app/Explicit.astro", floating, 4, 3, 4, 23],
          ["app/[slug].astro", floating, 13, 3, 13, 22],
          ["app/[slug].astro", floating, 8, 1, 8, 25],
        ],
      },
      { mode: "untyped", env: untyped, status: 0, expected: [] },
    ])(
      "Astro frontmatter reports original positions with $mode lint",
      ({ env, status, expected }) => {
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
        expect(run.status).toBe(status);
        expect(findings).toEqual(expected);
      },
    );
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
  const invalidStorage = `window.astroThemeToggle = { getTheme: () => "light", setTheme: () => undefined };
    Object.defineProperty(Storage.prototype, "setItem", { value: Storage.prototype.setItem.bind({}) });`;
  test.each([
    ["read", 'localStorage.setItem("theme", "dark"); window.astroThemeToggle = {};', ""],
    ["observer", invalidStorage, 'document.documentElement.dataset.theme = "dark";'],
    ["click", invalidStorage, 'document.querySelector("button").click();'],
  ])(
    "catalog theme %s propagates unexpected browser errors",
    async (_, setup, trigger) => {
      const head = readFileSync(join(import.meta.dirname, "../catalog/Head.astro"), "utf8");
      const inline = head.split("<script is:inline>")[1].split("</script>")[0];
      const served = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          new Response(
            `<!doctype html><html data-hw-night><body>
          <button data-hw-theme>Theme</button>
          <script>
            window.addEventListener("error", (event) => {
              document.documentElement.dataset.failure = event.error.name;
            });
            ${setup}
          </script>
          <script>${inline}</script><script>${trigger}</script>
          </body></html>`,
            { headers: { "Content-Type": "text/html" } },
          ),
      });
      try {
        const page = await browse(served.url.href);
        try {
          await page.until(
            `location.href === ${JSON.stringify(served.url.href)} && document.readyState === "complete"`,
          );
          expect(await page.evaluate("document.documentElement.dataset.failure")).toBe("TypeError");
        } finally {
          page.close();
        }
      } finally {
        await served.stop(true);
      }
    },
    limit(30_000),
  );

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
  test.each([
    [{ base: "/s", pages: ["types", "about.astro"] }, "/s/"],
    [{ base: "/s/", pages: ["index.astro"] }, "/s/catalog/"],
    [{ base: "/s/", pages: ["index.html.ts"] }, "/s/catalog/"],
    [{ base: "/s/", pages: ["index"] }, "/s/catalog/"],
    [{ base: "/s/", pages: ["[...slug].astro"] }, "/s/catalog/"],
    [{ base: "/s", pages: ["[slug].astro", "indexes"], dev: true }, "/"],
    [{ base: "/s", pages: ["index.astro"], dev: true }, "/catalog/"],
  ])("catalogPath for %j is %s", (input, expected) => {
    expect(catalogPath(input)).toBe(expected);
  });

  describe("brandFallbacks", () => {
    const tokens = {
      "--a": "calc(var(--b) + 1px)",
      "--b": "3px",
      "--c": "color-mix(in srgb, var(--a, var(--b)) 5%, white)",
      "--loop": "var(--loop)",
    };
    const css =
      ".x{a:var(--a);b:var( --b , calc(1px + var(--q)));c:var(--n, var(--b));d:var(--c);e:var(--z, 1px);f:var(--loop)}";
    test.each([
      {
        scenario: "nested var fallbacks",
        input: css,
        values: tokens,
        expected:
          ".x{a:var(--a, calc(var(--b, 3px) + 1px));b:var(--b, 3px);c:var(--n, var(--b, 3px));d:var(--c, color-mix(in srgb, var(--a, var(--b)) 5%, white));e:var(--z, 1px);f:var(--loop, var(--loop))}",
      },
      { scenario: "no token values", input: css, values: {}, expected: css },
      {
        scenario: "literal brand value with an absent token",
        input: ".x{a:brand-value(--b);b:brand-value( --n )}",
        values: tokens,
        expected: ".x{a:3px;b:var(--n)}",
      },
    ] as const)("resolves $scenario", ({ input, values, expected }) => {
      expect(brandFallbacks(input, values)).toBe(expected);
    });

    test.each([
      [".x{a:var(--b, calc(1px}", "no closing"],
      [".x{a:brand-value(--a)}", "no fixed value"],
      [".x{a:brand-value(--b, 1px)}", "one custom"],
    ])("reports the malformed declaration in %s", (input, error) => {
      expect(() => brandFallbacks(input, tokens)).toThrow(error);
    });
  });

  describe("rewriteRoute", () => {
    const route = [
      "import { parseStoryDefaultExport, parseStoryNamedExport } from 'astrobook/client';",
      "const { decorators, args } = parseStoryNamedExport(m, './a.stories.ts', 'One');",
      "---",
      "<StoryPage story={'a'} hasSidebar={true}>",
      "{isAstroComponent ? <m.default.component {...args} /> : <m.default.component {...args} client:load />}",
      "",
    ].join("\n");
    const drifted = route.replace(" client:load />", " client:visible />");
    test.each([
      ["one render branch", route],
      ["repeated render branches", `${route}${route.split("---")[1]}`],
    ])("rewrites a server-only story with %s", (_, input) => {
      const result = rewriteRoute("stories/a.astro", input, true);
      expect(result).toContain('import "virtual:scaffolding/catalog-css/stories";');
      expect(result).toContain("Astro.locals.hwCatalogLead = args?.lead;");
      expect(result).toContain("hasSidebar={true}");
      expect(result).not.toContain("client:load");
    });

    test("rewrites an interactive dashboard without its sidebar", () => {
      const result = rewriteRoute("dashboard/a.astro", route, false);
      expect(result).toContain("client:load");
      expect(result).toContain("hasSidebar={false}");
    });

    test("preserves a changed hydration directive on an interactive story", () => {
      expect(rewriteRoute("stories/a.astro", drifted, false)).toContain("client:visible");
    });

    test("a rewritten story does not change when rewritten again", () => {
      const out = rewriteRoute("stories/a.astro", route, true);
      assert(out, "the rewritten route");
      expect(rewriteRoute("stories/a.astro", out, true)).toBeUndefined();
    });

    test.each([
      {
        missing: "sidebar",
        path: "dashboard/a.astro",
        input: route.replace("hasSidebar={true}", ""),
        serverOnly: false,
        error: /sidebar/,
      },
      {
        missing: "client:load",
        path: "stories/a.astro",
        input: drifted,
        serverOnly: true,
        error: /client:load/,
      },
      {
        missing: "CSS import",
        path: "stories/a.astro",
        input: route.replace("'astrobook/client'", "'x'"),
        serverOnly: false,
        error: /CSS import/,
      },
      {
        missing: "recognized route folder",
        path: "other/a.astro",
        input: route,
        serverOnly: false,
        error: /CSS import/,
      },
    ] as const)(
      "refuses to rewrite a route missing its $missing",
      ({ path, input, serverOnly, error }) => {
        expect(() => rewriteRoute(path, input, serverOnly)).toThrow(error);
      },
    );
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
    const rewrite = (source: string) => rewriteRoute("stories/a.astro", source, false);
    expect(await rejection(readRouteUntilRewritten(file, rewrite, 100))).toContain("CSS import");
  });

  describe("the Astro catalog preset", () => {
    let dist: string;
    beforeAll(() => {
      dist = join(fixture, "dist");
    });
    const build = (args: string[] = [], env: Record<string, string> = {}, root = "catalog") =>
      spawnSync(astro, ["build", "--root", root, ...args], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, CI: "", ...env },
      });
    const prepareBuild = (args: string[] = [], root = "catalog") => {
      const result = build(args, {}, root);
      requireFixtureSuccess(
        `astro build --root ${root} ${args.join(" ")}`.trim(),
        result.status,
        result.stdout + result.stderr,
      );
    };
    const prepareVariant = (name: string, options: string) => {
      const result = variant(name, options);
      requireFixtureSuccess(
        `astro build --config ${name}.config.mjs`,
        result.status,
        result.stdout + result.stderr,
      );
    };
    const page = (p: string) => readFileSync(join(dist, p, "index.html"), "utf8");
    const root = (html: string) => {
      const match = html.match(/Object\.assign\(document\.documentElement\.dataset,(\{.*?\})\);/);
      assert(match, "the catalog's root dataset assignment");
      return match[1];
    };
    const styles = (html: string) =>
      [
        ...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g).map((m) => m[1]),
        ...html
          .matchAll(/<link rel="stylesheet" href="\/_astro\/([^"]+)"/g)
          .map((m) =>
            readFileSync(join(dist, "_astro", defined(m[1], "stylesheet filename")), "utf8"),
          ),
      ].join("");
    const links = (html: string, rel: string) =>
      [...html.matchAll(new RegExp(`<link rel="${rel}" href="([^"]*)"`, "g"))].map((m) => m[1]);
    const barOf = (html: string) => {
      const match = /<template id="hw-catalog-bar">([\s\S]*?)<\/template>/.exec(html);
      assert(match, "the catalog bar template");
      const [, body] = match;
      assert(body, "the catalog bar");
      return body;
    };
    const robots = /<meta\b[^>]*\bname\s*=\s*["']?robots\b/i;

    const statePath = "dashboard/Parts/box-parts/two";
    const alonePath = "stories/Parts/box-parts/two";
    describe("shared default build", () => {
      let home: string;
      beforeAll(() => {
        prepareBuild();
        home = page("");
      }, limit(60_000));
      test("the catalog is the site's home, with its header and provenance", () => {
        // `nav`: an href from "/" counts from the base, the current item links to /catalog/, which
        // forwards to the home.
        expect(home).toContain(
          '<header class="fx-header"><a href="/">Fx</a><div class="hw-header-nav hw-catalog-nav"><nav class="hw-header-nav" aria-label="Main" data-hw-catalogs><a class="hw-header-link" href="/">Site</a><a class="hw-header-link" href="/catalog/" aria-current="page">Fx</a><a class="hw-header-link" href="https://example.com/other/">Other</a><a class="hw-header-link" href="//example.com/far/">Far</a></nav></div></header>',
        );
        expect(home).toContain(
          '<p class="hw-catalog-provenance"><span>fx catalog/stories ·</span> <span>@acme/ui v1.2.3 ·</span> <span>3 components ·</span> <span>24 states</span></p>',
        );
        // The admin hub serves only on this machine: a built page carries no link to it.
        expect(home).not.toContain("admin.localhost");
      });

      test("the rail displays groups in order with links to the selected preview states", () => {
        expect(home.indexOf(">Types <")).toBeLessThan(home.indexOf(">Parts <"));
        // The rail names every element under its group, linked to the state its tile draws.
        expect(home).toMatch(
          /<ul class="hw-catalog-names"><li><a href="\/dashboard\/Parts\/box-parts\/two\/">Box parts<\/a>/,
        );
        // `previewStates` in order: the first a component has wins.
        expect(home).toContain('<a href="/dashboard/Parts/many-parts/block-image/">Many parts</a>');
      });

      test("frames use their declared dimensions and lazy source", () => {
        // A frame names its page in data-src: the shell's script loads it once the tile nears the view.
        expect(home).toContain('data-src="/stories/Types/box-types/two/"');
        expect(home).not.toMatch(/<iframe[^>]* src=/);
        expect(readdirSync(join(dist, "stories/Parts/box-parts"))).toEqual(["one", "two"]);
        // `previewSize` per group: a Types tile draws its frame whole at 1440 x 900, a Parts tile at
        // three quarters.
        expect(home).toContain(
          'data-frame-width="1440" style="aspect-ratio:1440/900"><iframe data-src="/stories/Types/box-types/two/"',
        );
        expect(home).toMatch(
          /<span class="hw-catalog-preview"><iframe data-src="\/stories\/Parts\//,
        );
      });

      test("the core shell marks brand elements that the scan should skip", () => {
        // The shell's own card, pill and rail (brand's search field and navigation list) carry
        // data-hw-shell, for brand-elements to skip.
        expect(home).toContain(
          '<aside class="hw-catalog-rail" data-hw-shell><div class="hw-search"><input class="hw-field hw-catalog-search" type="search"',
        );
        expect(home).toContain('<nav class="hw-nav" aria-label="Groups">');
        expect(home).toContain('<a class="hw-card hw-catalog-tile" data-hw-shell href=');
        expect(home).toContain('<span class="hw-pill" data-tone="neutral" data-hw-shell>');
      });

      test.each([
        ["", '{"hwScale":"dense","hwNight":""}'],
        [statePath, '{"hwScale":"screen","hwNight":""}'],
        [alonePath, '{"hwScale":"screen"}'],
      ] as const)("sets the scale, theme and root classes for /%s", (path, dataset) => {
        const html = page(path);
        expect(root(html)).toBe(dataset);
        expect(html).toContain('document.documentElement.classList.add(...["fx-root","fx-two"]);');
      });

      test.each(["", statePath])("adds the sidebar CSS to the shell at /%s", (path) => {
        expect(page(path)).toContain("#astrobook-sidebar");
      });

      test.each([alonePath])("omits the sidebar CSS from the standalone page at /%s", (path) => {
        expect(page(path)).not.toContain("#astrobook-sidebar");
      });

      test.each(["", statePath, alonePath, "catalog", "catalog/dashboard/Parts/box-parts/two"])(
        "/%s has no robots tag",
        (path) => {
          expect(page(path)).not.toMatch(robots);
        },
      );

      test.each([
        { path: "", title: "Fx catalog", description: "Lead.", canonical: "/" },
        {
          path: statePath,
          title: "Box parts: Two – Fx catalog",
          description: "Lead.",
          canonical: "/dashboard/Parts/box-parts/two/",
        },
        {
          path: alonePath,
          title: "Box parts: Two – Fx catalog",
          description: "Lead.",
          canonical: "/dashboard/Parts/box-parts/two/",
        },
        {
          path: "dashboard/Parts/box-parts/one",
          title: "Box parts: One – Fx catalog",
          description: "The first box.",
          canonical: "/dashboard/Parts/box-parts/one/",
        },
        {
          path: "stories/Parts/box-parts/one",
          title: "Box parts: One – Fx catalog",
          description: "The first box.",
          canonical: "/dashboard/Parts/box-parts/one/",
        },
      ])(
        "/$path exposes its title, description and canonical",
        ({ path, title, description, canonical }) => {
          const html = page(path);
          expect(html).toContain(`<title>${title}</title>`);
          expect(html).toContain(`<meta name="description" content="${description}">`);
          expect(links(html, "canonical")).toEqual([canonical]);
        },
      );

      test("preserves a plural acronym in a state title", () => {
        expect(page("dashboard/Parts/many-parts/two-pd-fs")).toContain(
          "<title>Many parts: Two PDFs – Fx catalog</title>",
        );
      });
      test(
        "the skeleton preview serves a built story from the repository root",
        async () => {
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
        },
        limit(60_000),
      );

      describe("the rendered default catalog", () => {
        let served: ReturnType<typeof Bun.serve>;
        let painted: Awaited<ReturnType<typeof browse>>;
        beforeAll(async () => {
          served = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch: (req) => {
              const { pathname } = new URL(req.url);
              return new Response(
                Bun.file(join(dist, pathname, pathname.endsWith("/") ? "index.html" : "")),
              );
            },
          });
          painted = await browse(`${served.url}`);
        }, limit(60_000));
        beforeEach(async () => {
          await painted.evaluate(
            "localStorage.clear(); document.documentElement.dataset.fixtureReset = 'pending'",
          );
          await painted.send("Page.navigate", { url: served.url.href });
          await painted.until(
            `location.pathname === "/" && document.readyState === "complete" && !document.documentElement.dataset.fixtureReset && !!document.querySelector(".hw-catalog")`,
          );
        }, limit(60_000));
        afterAll(() => {
          painted?.close();
          void served?.stop(true);
        });
        test(
          "refits a sized tile after the search shows it",
          async () => {
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
          },
          limit(60_000),
        );

        const groundToken =
          'document.documentElement.style.setProperty("--color-bg", "rgb(1, 2, 3)")';
        const groundRole =
          'document.documentElement.style.setProperty("--background", "rgb(4, 5, 6)")';
        const groundCSS =
          'document.head.insertAdjacentHTML("beforeend", "<style id=test-ground>@layer base { html { background: rgb(7, 8, 9); } }</style>")';
        test.each([
          ["no token or role value", "undefined", "rgba(0, 0, 0, 0)"],
          ["the brand token", groundToken, "rgb(1, 2, 3)"],
          ["the brand role", `${groundToken}; ${groundRole}`, "rgb(4, 5, 6)"],
          ["the story stylesheet", `${groundToken}; ${groundRole}; ${groundCSS}`, "rgb(7, 8, 9)"],
        ])(
          "the shell uses %s as its background",
          async (_, script, colour) => {
            await painted.evaluate(script);
            expect(
              await painted.evaluate(`getComputedStyle(document.documentElement).backgroundColor`),
            ).toBe(colour);
          },
          limit(60_000),
        );
        test(
          "the catalog reads the brand ink for body text",
          async () => {
            const ink = `document.documentElement.style.setProperty("--color-ink", "rgb(1, 2, 3)")`;
            // The shell's text reads brand's role or token, and a state's page whose CSS holds no reset
            // still draws the bar in the ink and its controls 28 px high.
            await painted.evaluate(ink);
            expect(await painted.evaluate(`getComputedStyle(document.body).color`)).toBe(
              "rgb(1, 2, 3)",
            );
          },
          limit(60_000),
        );

        test(
          "the dashboard bar takes the brand ink and keeps each control 28 px high",
          async () => {
            const ink = `document.documentElement.style.setProperty("--color-ink", "rgb(1, 2, 3)")`;
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
          },
          limit(60_000),
        );

        test(
          "the dashboard reserves the brand focus room unless the story sets padding",
          async () => {
            await painted.evaluate(`location.href = "/dashboard/Parts/box-parts/two/"`);
            await painted.until(
              `location.pathname.startsWith("/dashboard/") && document.readyState === "complete" && !!document.querySelector(".hw-catalog-bar")`,
            );
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
          },
          limit(60_000),
        );

        test(
          "the dashboard follows and changes the shared theme",
          async () => {
            await painted.evaluate(`location.href = "/dashboard/Parts/box-parts/two/"`);
            await painted.until(
              `location.pathname.startsWith("/dashboard/") && document.readyState === "complete" && !!document.querySelector(".hw-catalog-bar")`,
            );
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
          },
          limit(60_000),
        );

        test(
          "a standalone story reserves focus room without sharing its theme",
          async () => {
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
          },
          limit(60_000),
        );
      });
      test("former catalog URLs forward to the built root", () => {
        // Every page of the catalog's former place forwards to its page at the root.
        expect(page("catalog/dashboard/Parts/box-parts/two")).toContain(
          'http-equiv="refresh" content="0; url=/dashboard/Parts/box-parts/two/"',
        );
        expect(page("catalog")).toContain('content="0; url=/"');
      });

      test("repository head and sidebar suppression reach the dashboard", () => {
        expect(page(statePath)).toContain('<meta name="fx-head" content="repository">');
        expect(styles(page(statePath))).toMatch(
          /#astrobook-sidebar,\s*astrobook-sidebar-resize-handle\s*\{\s*display:\s*none\s*!important/,
        );
      });

      describe("stylesheet sources for each catalog page", () => {
        const sheets = new Map<string, string>();
        beforeAll(() => {
          for (const path of [statePath, alonePath, ""]) sheets.set(path, styles(page(path)));
        });

        test.each([
          [statePath, ".fx-header{display:flex}"],
          [statePath, ".hw-catalog-bar{"],
          [statePath, ".box{color:teal}"],
          [alonePath, ".box{color:teal}"],
          ["", ".fx-header{display:flex}"],
          ["", ".hw-catalog-grid{"],
          ["", ".acme-ui{"],
        ])("includes %s stylesheet fragment %s", (path, fragment) => {
          expect(sheets.get(path)).toContain(fragment);
        });

        test.each([
          [alonePath, ".fx-header{"],
          [alonePath, "hw-catalog-bar"],
          [alonePath, "hw-catalog-nav"],
          [alonePath, "astrobook-sidebar,"],
          ["", ".box{"],
        ])("excludes %s stylesheet fragment %s", (path, fragment) => {
          expect(sheets.get(path)).not.toContain(fragment);
        });
      });
      describe("dashboard bar", () => {
        let bar: string;
        beforeAll(() => {
          bar = barOf(page(statePath));
        });
        test("the dashboard bar has the current header, navigation and theme control", () => {
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
        });

        test("the dashboard bar links to the standalone state and marks the current state", () => {
          expect(bar).toMatch(
            /<a class="hw-catalog-tool" href="\/stories\/Parts\/box-parts\/two\/">\s*Open this state alone\s*<\/a>/,
          );
          expect(bar).toContain('<ul aria-label="States">');
          expect(bar).toMatch(/href="\/dashboard\/Parts\/box-parts\/one\/">One/);
          expect(bar).toMatch(
            /href="\/dashboard\/Parts\/box-parts\/two\/" aria-current="page">Two/,
          );
          expect(bar).toContain("2 of 2");
        });

        test("the last state's arrows link backwards and disable Next", () => {
          expect(bar).toContain(
            '<a class="hw-catalog-step" rel="prev" href="/dashboard/Parts/box-parts/one/"',
          );
          expect(bar).toContain(
            '<button class="hw-catalog-step" type="button" disabled aria-label="Next state">',
          );
          expect(bar).not.toMatch(/<a(?![^>]*href)[^>]*>/);
        });

        test("the first state's arrows link forwards and disable Previous", () => {
          const first = barOf(page("dashboard/Parts/box-parts/one"));
          expect(first).toContain(
            '<button class="hw-catalog-step" type="button" disabled aria-label="Previous state">',
          );
          expect(first).toContain(
            '<a class="hw-catalog-step" rel="next" href="/dashboard/Parts/box-parts/two/"',
          );
          expect(first).not.toMatch(/<a(?![^>]*href)[^>]*>/);
        });
      });

      describe("the dashboard's long state menu", () => {
        let many: string;
        beforeAll(() => {
          many = barOf(page("dashboard/Parts/many-parts/block-image"));
        });
        test("the dashboard groups a long state list into a menu", () => {
          // Above 12 states a menu replaces the chips, grouped by a word three names share.
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
        });

        test.each([
          [/many-parts\/density-on-pdf\/">Density on PDF</],
          [/">Folie 35 Eine Woche zum</],
          [/">In German</],
          [/">Mit impressum</],
          [/">Primary on night</],
          [/many-parts\/two-pd-fs\/">Two PDFs</],
          [/many-parts\/loading-git-hub\/">Loading GitHub</],
        ])("humanizes a state name as %s", (pattern) => {
          expect(many).toMatch(pattern);
        });
      });
      test("the parser inserts the bar only on a dashboard", () => {
        expect(page(statePath)).toContain("if (top) main.before(top);");
        expect(page("stories/Parts/box-parts/two")).not.toContain('id="hw-catalog-bar"');
        expect(home).not.toContain('id="hw-catalog-bar"');
      });

      test("server-only stories ship no hydrated bundle", () => {
        // `serverOnly`: no state's route keeps Astrobook's client:load branch, so no story module
        // ships to the browser.
        expect(globSync("_astro/*.stories.*", { cwd: dist })).toEqual([]);
      });

      test("the build serves public assets and copies only the selected asset paths", () => {
        expect(readFileSync(join(dist, "fx.txt"), "utf8")).toBe("fx\n");
        // `copy`: each match at its own path, the rest of the folder left out.
        expect(readdirSync(join(dist, "assets")).sort()).toEqual(["logo.svg", "nested"]);
        expect(readFileSync(join(dist, "assets/nested/page.css"), "utf8")).toBe(
          "a {\n  color: red;\n}\n",
        );
        // A package path lands at that path, resolved through the package's exports.
        expect(readFileSync(join(dist, "@acme/fx/logos/logo.svg"), "utf8")).toBe(
          readFileSync(join(fixture, "assets/logo.svg"), "utf8"),
        );
      });

      test("the default home adds no Foundations group", () => {
        expect(home).not.toContain('id="foundations"');
      });
    });
    test(
      "an empty catalog keeps the lead and omits provenance",
      () => {
        // An app with no stories folder builds a home without the line that would count nothing.
        const empty = join(fixture, "empty");
        write(empty, {
          "astro.config.mjs":
            'import { catalog } from "../../../catalog/index.ts";\nexport default { integrations: [catalog({ product: "Fx", css: [], lead: "", header: { component: "../catalog/Header.astro" } })] };\n',
        });
        prepareBuild([], "empty");
        const emptyHome = readFileSync(join(empty, "dist", "index.html"), "utf8");
        expect(emptyHome).toContain('class="hw-catalog-lead"');
        expect(emptyHome).not.toContain("hw-catalog-provenance");
      },
      limit(60_000),
    );

    test(
      "a project Pages base prefixes the catalog navigation and former URLs",
      () => {
        // A project Pages site sets Astro's base: the links and the header's default follow it.
        prepareBuild(["--base", "/fx"]);
        const based = readFileSync(join(dist, "index.html"), "utf8");
        expect(based).toContain(
          '<header class="fx-header"><a href="/fx/">Fx</a><div class="hw-header-nav hw-catalog-nav"><nav class="hw-header-nav" aria-label="Main" data-hw-catalogs><a class="hw-header-link" href="/fx/">Site</a><a class="hw-header-link" href="/fx/catalog/" aria-current="page">Fx</a><a class="hw-header-link" href="https://example.com/other/">Other</a><a class="hw-header-link" href="//example.com/far/">Far</a></nav></div></header>',
        );
        expect(based).toContain('data-src="/fx/stories/Types/box-types/two/"');
        expect(page("catalog/stories/Types/box-types/two")).toContain(
          'url=/fx/stories/Types/box-types/two/"',
        );
      },
      limit(60_000),
    );

    test(
      "a base ending in /catalog leaves forwarding and public files to its host",
      () => {
        // A base ending in /catalog mounts the catalog under a host with its own home: no forwarding
        // pages and no public/, which the host serves.
        prepareBuild(["--base", "/catalog"]);
        const mountedHome = readFileSync(join(dist, "index.html"), "utf8");
        expect(mountedHome).toContain('data-src="/catalog/stories/Types/box-types/two/"');
        // Its home reads /catalog/ already: the current item links there, not to /catalog/catalog/.
        expect(mountedHome).toContain(
          '<a class="hw-header-link" href="/catalog/" aria-current="page">Fx</a>',
        );
        expect(page("dashboard/Parts/box-parts/two")).toContain(
          '<a href="/catalog/"><span aria-hidden',
        );
        expect(readdirSync(dist)).not.toContainEqual(matchingText(/^(?:catalog|fx\.txt)$/));
      },
      limit(60_000),
    );

    test(
      "an explicit outDir is kept",
      () => {
        // An outDir the config sets stays; only Astro's default moves to the repository's dist/.
        const custom = join(fixture, "catalog", "custom");
        prepareBuild(["--outDir", "./custom"]);
        expect(existsSync(join(custom, "index.html"))).toBe(true);
      },
      limit(60_000),
    );

    test.each([
      ["ignore", ""],
      ["always", "/"],
    ])(
      "file-format pages link with trailingSlash %s",
      (slash, end) => {
        const files = join(fixture, "catalog", "files.config.mjs");
        writeFileSync(
          files,
          `import config from "./astro.config.mjs";\nexport default { ...config, trailingSlash: "${slash}", build: { format: "file" } };\n`,
        );
        try {
          prepareBuild(["--config", "files.config.mjs"]);
          expect(page("")).toContain(
            `<li><a href="/dashboard/Parts/box-parts/two${end}">Box parts</a>`,
          );
        } finally {
          rmSync(files);
        }
      },
      limit(60_000),
    );
    describe("a catalog opened from disk", () => {
      let onDisk: string;
      const at = (path: string) => pathToFileURL(join(dist, path)).href;
      beforeAll(() => {
        // A build with a file-URL assetsPrefix is opened from disk: every link to a page or file of the
        // build names its file by file URL, the home's frames, a copied file and a state menu's options
        // included; a link outside the build stays, and no page forwards from /catalog/.
        const disk = join(fixture, "catalog", "disk.config.mjs");
        writeFileSync(
          disk,
          `import config from "./astro.config.mjs";\nexport default { ...config, build: { assetsPrefix: ${JSON.stringify(pathToFileURL(`${dist}/`).href)} } };\n`,
        );
        prepareBuild(["--config", "disk.config.mjs"]);
        onDisk = readFileSync(join(dist, "index.html"), "utf8");
        rmSync(disk);
      }, limit(60_000));

      test.each([
        [
          "the story frame",
          () => `<iframe data-src="${at("stories/Types/box-types/two/index.html")}"`,
        ],
        [
          "the dashboard link",
          () => `<li><a href="${at("dashboard/Parts/box-parts/two/index.html")}">Box parts</a>`,
        ],
        ["the catalog home", () => `<a href="${at("index.html")}">Fx</a>`],
        [
          "the current header link",
          () => `<a class="hw-header-link" href="${at("index.html")}" aria-current="page">Fx</a>`,
        ],
        ["the external header link", () => 'href="https://example.com/other/"'],
        ["the icon", () => `<link rel="icon" href="${at("assets/logo.svg")}">`],
      ])("links to %s by file URL", (_, expected) => {
        expect(onDisk).toContain(expected());
      });

      test("links to a standalone state and a menu option by file URL", () => {
        expect(onDisk).not.toMatch(/\s(href|src|data-src)="\/(?!\/)/);
        expect(page(statePath)).toContain(
          `href="${at("stories/Parts/box-parts/two/index.html")}">Open this state alone`,
        );
        expect(page("dashboard/Parts/many-parts/block-image")).toContain(
          `<option value="${at("dashboard/Parts/many-parts/block-code/index.html")}">Block code</option>`,
        );
      });

      test("does not publish a canonical link or old /catalog redirects", () => {
        expect(onDisk).not.toContain('rel="canonical"');
        expect(existsSync(join(dist, "catalog"))).toBe(false);
      });
    });
    test(
      "rejects a redirect that takes over the catalog home",
      () => {
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
      },
      limit(60_000),
    );

    test(
      "refuses to copy a file omitted from a package's exports",
      () => {
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
      },
      limit(60_000),
    );

    test(
      "rejects a current navigation item that does not exist",
      () => {
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
      },
      limit(60_000),
    );

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
    test(
      "dashboard CSS replaces regular story CSS on the dashboard only",
      () => {
        // `dashboardCss` replaces `css` on a state's page; a state alone keeps `css`.
        const dash = join(fixture, "catalog", "dash.css");
        writeFileSync(dash, ".dash{color:red}\n");
        prepareVariant("dashed", 'css: ["./fx.css"], dashboardCss: ["./dash.css"]');
        const dashCss = styles(page("dashboard/Parts/box-parts/two"));
        expect(dashCss).toContain(".dash{color:red}");
        expect(dashCss).not.toContain(".box{");
        expect(styles(page("stories/Parts/box-parts/two"))).toContain(".box{color:teal}");
        rmSync(dash);
      },
      limit(60_000),
    );

    test(
      "focus-ring class can be used in a catalog without brand",
      () => {
        // Without brand, hw-focus-ring in `htmlClass` loads no focus ring and fails no build.
        expect(variant("ringless", 'htmlClass: ["hw-focus-ring"]').status).toBe(0);
      },
      limit(60_000),
    );

    test(
      "rejects a preview size for an unknown story group",
      () => {
        // A `previewSize` key naming no group fails the build by name: a renamed group would fall back
        // to the small fitted view unseen.
        const stale = variant("stale", "previewSize: { Parts: [1, 1], Pieces: [1440, 900] }");
        expect(stale.status).not.toBe(0);
        expect(`${stale.stdout}${stale.stderr}`).toContain(
          'catalog previewSize: "Pieces" names no story group (Parts, Types)',
        );
      },
      limit(60_000),
    );

    test(
      "rejects a configured preview state absent from all stories",
      () => {
        // A `previewStates` entry naming no story's state fails the build by name: a renamed state
        // would leave every tile on another state unseen.
        const unknown = variant("unknown", 'previewStates: ["two", "gone"]');
        expect(unknown.status).not.toBe(0);
        expect(`${unknown.stdout}${unknown.stderr}`).toContain(
          'catalog previewStates: "gone" names no story\'s state',
        );
      },
      limit(60_000),
    );

    test(
      "themeToggle false disables the catalog's theme and control",
      () => {
        // `themeToggle: false`: the bar offers no dark theme.
        prepareVariant("light", "themeToggle: false");
        expect(page("dashboard/Parts/box-parts/two")).not.toContain(
          '<button type="button" data-hw-theme',
        );
        expect(root(page("dashboard/Parts/box-parts/two"))).toBe("{}");
      },
      limit(60_000),
    );

    test(
      "a configured site makes canonical URLs absolute under the base",
      () => {
        // With a `site` the canonical URL is absolute, under the base.
        prepareBuild(["--site", "https://fx.example", "--base", "/fx"]);
        expect(page("stories/Parts/box-parts/two")).toContain(
          '<link rel="canonical" href="https://fx.example/fx/dashboard/Parts/box-parts/two/"',
        );
        expect(page("")).toContain('<link rel="canonical" href="https://fx.example/fx/"');
      },
      limit(60_000),
    );

    test(
      "a catalog without brand keeps the repository favicon and typography",
      () => {
        // Where the repository resolves brand, every page carries brand's favicon ahead of the
        // repository's head, whose own link then wins; without brand the shell writes none.
        prepareBuild();
        expect(links(page(""), "icon")).toEqual(["/assets/logo.svg"]);
        // Without brand the bar reads the repository's own --text-ui.
        const brandless = globSync("**/*.{css,html}", { cwd: dist })
          .map((f) => readFileSync(join(dist, f), "utf8"))
          .join("");
        const bar = brandless.match(/\.hw-catalog-bar\{[^}]*\}/);
        assert(bar, "the catalog bar stylesheet");
        expect(bar[0]).toContain(
          "font:500 1rem var(--font-sans);font-size:var(--text-ui);line-height:var(--text-ui--line-height);",
        );
        expect(brandless).not.toContain("brand-value");
      },
      limit(60_000),
    );

    describe("a custom catalog home and Foundations", () => {
      let catalogDir: string, homed: string, ownHome: string, folder: string;
      beforeAll(() => {
        catalogDir = join(fixture, "catalog");
        homed = join(catalogDir, "homed.config.mjs");
        ownHome = join(catalogDir, "OwnHome.astro");
        folder = join(catalogDir, "stories", "Foundations");
      });
      afterAll(() => {
        for (const path of [folder, homed, ownHome]) rmSync(path, { recursive: true, force: true });
      });
      const ownHomeWith = (body: string) =>
        write(catalogDir, {
          "homed.config.mjs":
            'import config from "./astro.config.mjs";\nimport { catalog } from "../../../catalog/index.ts";\nexport default { ...config, compressHTML: false, integrations: [catalog({ product: "Fx", css: [], lead: "", header: { component: "./Header.astro" }, home: "./OwnHome.astro" })] };\n',
          "OwnHome.astro": `---\nimport Home from "../../../catalog/Home.astro";\n---\n\n<Home>${body}</Home>\n`,
        });
      test(
        "adds a Foundations group when the custom home has content",
        () => {
          ownHomeWith("<p>Tokens</p>");
          prepareBuild(["--config", "homed.config.mjs"]);
          expect(readFileSync(join(dist, "index.html"), "utf8")).toContain('id="foundations"');
        },
        limit(60_000),
      );

      describe("beside a stories group of the same name", () => {
        beforeAll(() => {
          write(folder, {
            "Tokens.stories.js":
              'import Box from "../../Box.astro";\n\nexport default { component: Box };\nexport const One = { args: { label: "one" } };\n',
          });
        });

        test(
          "refuses two groups that resolve to the same anchor",
          () => {
            ownHomeWith("<p>Tokens</p>");
            const twice = build(["--config", "homed.config.mjs"]);
            expect(twice.status).not.toBe(0);
            expect(`${twice.stdout}${twice.stderr}`).toContain(
              'catalog: the groups "Foundations" and "Foundations" both draw as #foundations',
            );
          },
          limit(60_000),
        );

        test(
          "a whitespace-and-comment home leaves just the story group",
          () => {
            ownHomeWith("\n  <!-- none yet -->\n");
            prepareBuild(["--config", "homed.config.mjs"]);
            const folderOnly = readFileSync(join(dist, "index.html"), "utf8");
            expect(folderOnly.match(/id="foundations"/g)).toHaveLength(1);
            expect(folderOnly).not.toContain('class="hw-catalog-text"');
          },
          limit(60_000),
        );
      });
    });
    describe("with brand installed", () => {
      let brand: string, navless: string;
      beforeAll(() => {
        brand = join(fixture, "node_modules", "@hackersandwizards", "brand");
        navless = join(fixture, "catalog", "navless.config.mjs");
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
      });
      afterAll(() => {
        rmSync(navless, { force: true });
        rmSync(join(fixture, "node_modules"), { recursive: true, force: true });
      });

      describe("using the brand header", () => {
        let branded: string, brandedState: string, sheets: string;
        beforeAll(() => {
          prepareBuild(["--config", "navless.config.mjs"]);
          branded = readFileSync(join(dist, "index.html"), "utf8");
          sheets = [
            branded,
            ...globSync("**/*.css", { cwd: dist }).map((f) => readFileSync(join(dist, f), "utf8")),
          ]
            .join("")
            .replace(/,\s+/g, ",");
          brandedState = readFileSync(
            join(dist, "dashboard/Parts/box-parts/two/index.html"),
            "utf8",
          );
        }, limit(60_000));
        test.each([
          "var(--container-measure,31em)",
          "var(--text-page,1.7rem)",
          "var(--spacing-app-header,calc(var(--spacing-strip,5px) + 2rem))",
          "var(--radius-pill,77px)",
        ])("uses %s as a brand fallback", (fallback) => {
          expect(sheets).toContain(fallback);
        });

        test("uses the unscaled brand UI step", () => {
          // The bar's size is brand's unscaled UI step.
          expect(sheets).toMatch(
            /\.hw-catalog-bar\{[^}]*font:500 1rem var\(--font-sans\);[^}]*font-size:\.9rem;line-height:1\.55;/,
          );
          expect(sheets).not.toContain("brand-value");
        });

        test("the brand header uses its layer order and supplies catalog navigation", () => {
          // brand's layer order follows the ground's.
          expect(branded).toContain(
            "<style>@layer hw-catalog-ground;@layer properties, theme, base, components, utilities;@layer hw-catalog-ground{",
          );
          expect(branded).toContain(
            '<nav class="hw-header-nav" aria-label="Main" data-hw-catalogs><a class="hw-header-link" href="https://example.com/other/">Other</a><a class="hw-header-link" href="/catalog/" aria-current="page">Fx</a></nav>',
          );
        });

        test.each([["home"], ["dashboard"]])(
          "%s gets brand's theme switch and focus class",
          (kind) => {
            const pages = new Map([
              ["home", branded],
              ["dashboard", brandedState],
            ]);
            const html = pages.get(kind);
            assert(html, kind);
            expect(html).toMatch(/<\/nav><button id="theme-toggle"[^>]*>T<\/button><\/div>/);
            expect(root(html)).toContain('"hwNight":""');
            expect(html).toContain('classList.add(...["hw-focus-ring"])');
          },
        );

        test("the branded dashboard does not add a second theme switch", () => {
          expect(brandedState).not.toContain('<button type="button" data-hw-theme');
        });
        describe("a streamed dashboard response", () => {
          let slow: ReturnType<typeof Bun.serve>;
          let browsing: Awaited<ReturnType<typeof browse>>;
          const order: string[] = [];
          let release = () => {};
          beforeAll(async () => {
            // A state's page holds its header in a <template> the preload scanner skips and puts it into
            // <main> as the parser reaches it. The head's script asks for the logo before the rest of the
            // document arrives, and leaves a logo marked lazy to the browser. The server holds the rest
            // until the logo is whole in the page, 8 s at most: a lazy logo asked for in the same loop
            // has reached the server by then, and a loaded machine cannot reorder the two.
            const released = new Promise<void>((done) => (release = done));
            slow = Bun.serve({
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
            browsing = await browse(`${slow.url}dashboard/Parts/box-parts/two/`);
          }, limit(60_000));
          afterAll(() => {
            browsing?.close();
            void slow?.stop(true);
          });
          test(
            "preloads the header logo in the head, leaving the lazy image until the rest",
            async () => {
              await browsing.until(
                `performance.getEntriesByType("resource").some((e) => e.name.includes("lockup-screen"))`,
              );
              release();
              await browsing.until(`document.querySelector("img.hw-header-logo")?.complete`);
              expect(order).toContain("rest sent");
              const early = order.slice(0, order.indexOf("rest sent")).join();
              expect(early).toContain("lockup-screen");
              expect(early).not.toContain("night-logo");
            },
            limit(60_000),
          );
        });
      });
      test(
        "themeToggle false omits both brand and primary theme controls",
        () => {
          // `htmlClass` holding brand's hw-focus-ring loads brand's focus ring on every page; without
          // the class no page loads it. A `themeToggle` of false leaves brand's switch out of the
          // header and offers the bar's none either.
          prepareVariant("unswitched", "themeToggle: false");
          expect(page("")).not.toContain('id="theme-toggle"');
          expect(page("dashboard/Parts/box-parts/two")).not.toContain(
            '<button type="button" data-hw-theme',
          );
        },
        limit(60_000),
      );

      const ring = ".hw-focus-ring :focus-visible{outline:3px solid purple}";
      describe.each([
        ["ringoff", "htmlClass: []", withoutText(ring)],
        ["ringed", 'htmlClass: ["hw-focus-ring"]', containingText(ring)],
      ] as const)("%s focus styling", (name, options, expected) => {
        beforeAll(() => {
          prepareVariant(name, options);
        }, limit(60_000));
        test.each([[""], [statePath], [alonePath]])("applies to /%s", (path) => {
          expect(styles(page(path))).toEqual(expected);
        });
      });
      test(
        "an explicit focus.css is loaded once before the other story CSS",
        () => {
          // A list naming focus.css itself loads it once, ahead of the list's other sheets.
          prepareVariant(
            "ringtwice",
            'css: ["./fx.css", "@hackersandwizards/brand/elements/focus.css"], htmlClass: ["hw-focus-ring"]',
          );
          const alone = styles(page("stories/Parts/box-parts/two"));
          expect(alone.split(ring)).toHaveLength(2);
          expect(alone.indexOf(ring)).toBeLessThan(alone.indexOf(".box{color:teal}"));
        },
        limit(60_000),
      );

      describe("brand's favicon", () => {
        beforeAll(() => {
          prepareBuild();
        }, limit(60_000));

        test.each([[""], [alonePath]])(
          "is inserted ahead of the repository icon on /%s",
          (path) => {
            const [icon, ...others] = links(page(path), "icon");
            expect(icon).toMatch(/^\/_astro\/favicon\..*\.svg$/);
            expect(others).toEqual(["/assets/logo.svg"]);
          },
        );
      });
      test(
        "rejects brand older than the focus room token",
        () => {
          // The shell's type sizes are brand's tokens.json steps (brand v2.5.0), the focus ring's room is
          // brand's --hw-focus-room (v2.10.0).
          const brandPkg = join(brand, "package.json");
          const original = readFileSync(brandPkg, "utf8");
          let older: ReturnType<typeof build>;
          try {
            writeFileSync(brandPkg, JSON.stringify({ ...JSON.parse(original), version: "2.9.0" }));
            older = build();
          } finally {
            writeFileSync(brandPkg, original);
          }
          expect(older.status).not.toBe(0);
          expect(older.stdout + older.stderr).toContain(
            "needs @hackersandwizards/brand v2.10.0 or later, installed is v2.9.0",
          );
        },
        limit(60_000),
      );
    });
    describe("alongside a repository's own pages", () => {
      let src: string, pages: string;
      const head = (body: string) =>
        `<html lang="en"><head><title>t</title>${body}</head><body></body></html>\n`;
      beforeAll(() => {
        src = join(fixture, "catalog", "src");
        pages = join(src, "pages");
        mkdirSync(join(pages, "catalog"), { recursive: true });
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
      });
      afterAll(() => {
        rmSync(src, { recursive: true, force: true });
      });
      afterEach(() => {
        for (const file of ["headless.astro", "catalog/index.astro"])
          rmSync(join(pages, file), { force: true });
      });
      describe("robots policy in a build with its own pages and endpoints", () => {
        beforeAll(() => {
          prepareBuild();
        }, limit(60_000));

        test("a regular page keeps its head without a robots tag", () => {
          const html = page("own");
          expect(html).toContain("<head><title>");
          expect(html).not.toMatch(robots);
        });

        test("an explicit robots index tag is preserved", () => {
          const html = page("kept");
          expect(html).toMatch(robots);
          expect(html).toContain('<meta name="robots" content="index">');
          expect(html).not.toContain("noindex");
        });

        test.each([
          ["tagged.html", '<html><head><meta name="robots" content="noindex"></head></html>'],
          ["raw.html", "<html><head></head></html>"],
        ])("leaves the endpoint %s byte-for-byte", (file, html) => {
          expect(readFileSync(join(dist, file), "utf8")).toBe(html);
        });
      });

      test(
        "accepts a page with no head and adds no robots tag",
        () => {
          writeFileSync(join(pages, "headless.astro"), "<p>no head</p>\n");
          // A page without <head> builds.
          prepareBuild();
          expect(page("headless")).toContain("no head");
          expect(page("headless")).not.toMatch(robots);
        },
        limit(60_000),
      );

      test(
        "keeps an explicit /catalog route beside a catalog at the root",
        () => {
          // A page of the site's own at /catalog/ beside a root catalog keeps its place: the catalog
          // links its home.
          writeFileSync(join(pages, "catalog", "index.astro"), head("<p>site catalog page</p>"));
          prepareBuild();
          expect(page("catalog")).toContain("site catalog page");
          expect(page("")).toContain(
            '<a class="hw-header-link" href="/" aria-current="page">Fx</a>',
          );
        },
        limit(60_000),
      );

      describe("the site with its own home", () => {
        beforeAll(() => {
          // A site with a home page of its own keeps the catalog at /catalog/; no page gets a robots tag.
          writeFileSync(join(pages, "index.astro"), head("<p>site home</p>"));
          writeFileSync(join(pages, "catalog", "extra.astro"), head(""));
          prepareBuild();
        }, limit(60_000));
        afterAll(() => {
          rmSync(join(pages, "index.astro"), { force: true });
          rmSync(join(pages, "catalog", "extra.astro"), { force: true });
        });

        test("puts the catalog under /catalog", () => {
          expect(page("")).toContain("site home");
          expect(page("catalog")).toContain("fx catalog/stories");
          expect(page("catalog/dashboard/Parts/box-parts/two")).toContain('href="/catalog/"');
        });
        test.each([[""], ["own"], ["catalog/extra"]])(
          "does not add a robots tag to /%s",
          (path) => {
            expect(page(path)).not.toMatch(robots);
          },
        );
      });
    });
    test(
      "CI rejects a Git LFS pointer in the catalog's copied inputs",
      () => {
        // In CI a copied file still a Git LFS pointer fails the build; locally it passes.
        const ci = build([], { CI: "true" });
        expect(ci.status).not.toBe(0);
        expect(`${ci.stdout}${ci.stderr}`).toContain(
          "catalog copy: still Git LFS pointers: assets/nested/lfs.woff2",
        );
      },
      limit(60_000),
    );
  });

  // A repository's head sets attributes on <html> and runs page scripts: Astrobook's client router
  // swaps pages in place, which drops both until a reload.
  describe("the catalog development server", () => {
    let src: string;
    let server: Awaited<ReturnType<(typeof import("../lib/serve.ts"))["serve"]>>;
    beforeAll(async () => {
      const { serve } = await import("../lib/serve.ts");
      // Modules at paths a forward would take, as a site whose Astro root holds catalog/ serves its
      // catalog/Head.astro and catalog/stories/ under the base /catalog.
      for (const dir of ["fx", "catalog/stories"]) {
        mkdirSync(join(fixture, "catalog", dir), { recursive: true });
        writeFileSync(join(fixture, "catalog", dir, "mod.css"), "a {\n  color: red;\n}\n");
      }
      // A page of the site's own at /catalog/, written before dev starts: dev reads no page added
      // under node_modules, where the copy lies.
      src = join(fixture, "catalog", "src");
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
      server = await serve(
        [
          "sh",
          "-c",
          `unset VITEST && cd '${fixture}' && exec '${astro}' dev --root catalog --config virtual.config.mjs --base /fx --host $HOST --port $PORT`,
        ],
        { env: { ASTRO_DEV_BACKGROUND: "1" }, timeoutMs: 30_000 },
      );
    }, limit(90_000));
    afterAll(() => {
      server?.stop();
      rmSync(src, { recursive: true, force: true });
    });

    test.each([["/assets/logo.svg"], ["/@acme/fx/logos/logo.svg"]])(
      "serves the copied SVG %s",
      async (path) => {
        const result = await fetch(`${server.url}${path}`);
        expect({ status: result.status, contentType: result.headers.get("content-type") }).toEqual({
          status: 200,
          contentType: "image/svg+xml",
        });
      },
      limit(90_000),
    );

    test.each<{
      path: string;
      contentType: string;
      body: string;
      files: Record<string, string>;
    }>([
      {
        path: "/assets/nested/page.css",
        contentType: "text/css",
        body: "a {\n  color: red;\n}\n",
        files: {},
      },
      {
        path: "/assets/nested/data.constructor",
        contentType: "application/octet-stream",
        body: "own file",
        files: { "assets/nested/data.constructor": "own file" },
      },
    ])(
      "serves $path with its MIME type and original bytes",
      async ({ path, contentType, body, files }) => {
        write(fixture, files);
        const result = await fetch(`${server.url}${path}`);
        expect({
          contentType: result.headers.get("content-type"),
          body: await result.text(),
        }).toEqual({ contentType, body });
      },
      limit(90_000),
    );

    test(
      "serves page modules from other Vite plugins",
      async () => {
        const result = await fetch(`${server.url}/virtual/`);
        expect({ status: result.status, body: await result.text() }).toEqual({
          status: 200,
          body: containingText("from the fixture plugin"),
        });
      },
      limit(90_000),
    );

    test(
      "leaves an uncopied asset unavailable",
      async () => {
        expect((await fetch(`${server.url}/assets/skip.txt`)).status).toBe(404);
      },
      limit(90_000),
    );

    test(
      "a second copy glob finds an asset that appeared after the first fetch",
      async () => {
        const existing = await fetch(`${server.url}/assets/logo.svg`);
        expect(existing.status).toBe(200);
        writeFileSync(join(fixture, "assets", "late.svg"), "<svg/>");
        expect((await fetch(`${server.url}/assets/late.svg`)).status).toBe(200);
      },
      limit(90_000),
    );

    test(
      "a state's page has its own title in dev",
      async () => {
        expect(
          await (await fetch(`${server.url}/fx/dashboard/Parts/box-parts/one/`)).text(),
        ).toContain("<title>Box parts: One – Fx catalog</title>");
      },
      limit(90_000),
    );

    test(
      "links to the installed repository's dashboard in the local hub",
      async () => {
        expect(await (await fetch(`${server.url}/`)).text()).toMatch(
          /<a class="hw-header-link" href="http:\/\/admin\.localhost:4329\/scaffolding\/dashboard"[^>]*><span aria-hidden="true"[^>]*>←&nbsp;<\/span>Admin hub<\/a>/,
        );
      },
      limit(90_000),
    );

    test.each([
      ["/catalog/dashboard/Parts/box-parts/two?x", "/dashboard/Parts/box-parts/two?x"],
      ["/fx/catalog/", "/catalog/"],
      ["/catalog/stories/%E2%82%AC", "/stories/%E2%82%AC"],
      ["/fx//evil.example/x", "/evil.example/x"],
    ])(
      "redirects %s to %s",
      async (old, to) => {
        const result = await fetch(`${server.url}${old}`, { redirect: "manual" });
        expect([result.status, result.headers.get("location")]).toEqual([307, to]);
      },
      limit(90_000),
    );

    test.each([["/fx/mod.css"], ["/catalog/stories/mod.css"]])(
      "serves the module %s where it lives",
      async (path) => {
        expect((await fetch(`${server.url}${path}`, { redirect: "manual" })).status).toBe(200);
      },
      limit(90_000),
    );

    test(
      "does not redirect the site's own path under /catalog",
      async () => {
        expect(
          (await fetch(`${server.url}/catalog/print/`, { redirect: "manual" })).status,
        ).not.toBe(307);
      },
      limit(90_000),
    );

    test(
      "serves the repository's page at /catalog",
      async () => {
        const result = await fetch(`${server.url}/catalog/`, { redirect: "manual" });
        expect(result.status).toBe(200);
        expect(await result.text()).toContain("site catalog page");
      },
      limit(90_000),
    );

    test(
      "clicking a dashboard bar link fully loads the next document",
      async () => {
        const page = await browse(`${server.url}/dashboard/Parts/box-parts/two`);
        try {
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
        } finally {
          page.close();
        }
      },
      limit(90_000),
    );

    test(
      "the right arrow changes states unless the story handled it",
      async () => {
        const page = await browse(`${server.url}/dashboard/Parts/box-parts/one/`);
        try {
          const { evaluate, until } = page;
          await until(`document.readyState === "complete" && !!document.body.dataset.fxRan`);
          await evaluate(
            `window.addEventListener("keydown", (e) => e.preventDefault(), { once: true }); document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))`,
          );
          await Bun.sleep(500);
          expect(String(await evaluate("location.pathname")).endsWith("/one/")).toBe(true);
          await evaluate(
            `document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))`,
          );
          await until(`location.pathname.endsWith("/two/") && document.readyState === "complete"`);
        } finally {
          page.close();
        }
      },
      limit(90_000),
    );
  });

  // 40 tiles, each framing a page whose spec text sits above the element it marks as its preview.
  describe("catalog tile frames", () => {
    let server: ReturnType<typeof Bun.serve>;
    let page: Awaited<ReturnType<typeof browse>>;
    const asked: string[] = [];
    const failed: string[] = [];
    let near: number, paint: number, firstFrame: number;
    let tiles: Record<string, number | string>[];
    let scrolled: { asked: string[]; failed: string[] };
    let inline: { count: number; hasSource: unknown; failed: string[] };
    let hidden: unknown, hiddenRequests: number;
    beforeAll(async () => {
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
      server = Bun.serve({
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
      page = await browse("about:blank", ["--window-size=1280,800"]);
      const { ws, send, evaluate, until: ready } = page;
      ws.addEventListener("message", (event) => {
        const m = jsonObject(String(event.data));
        if (m.method === "Network.loadingFailed")
          failed.push(String(member(m, "params", "errorText")));
      });
      await send("Network.enable");
      const frames = (prefix: string) => asked.filter((p) => p.startsWith(prefix)).length;
      await send("Page.navigate", { url: `${server.url}home` });
      const fitted = `(() => { const f = document.querySelector(".hw-catalog-preview iframe"); return !!f.contentDocument?.querySelector("[data-hw-preview]") && f.style.transform.includes("scale"); })()`;
      await ready(`document.readyState === "complete" && ${fitted}`);
      await new Promise((r) => setTimeout(r, 1000));
      // Only the tiles in or near the view load: four rows of three at 1280 x 800, not all 40.
      near = frames("/story/");
      // No frame starts before the first paint.
      [paint, firstFrame] = (await evaluate(
        `[performance.getEntriesByName("first-paint")[0]?.startTime, Math.min(...performance.getEntriesByType("resource").filter((e) => e.initiatorType === "iframe").map((e) => e.startTime))]`,
      )) as [number, number];
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
      tiles = await Promise.all([fit(0), fit(1)]);
      // Scrolled to the end, the last tile loads.
      await evaluate(`document.querySelector(".hw-catalog-grid li:last-child").scrollIntoView()`);
      await ready(
        `!!document.querySelector(".hw-catalog-grid li:last-child iframe").contentDocument?.querySelector("[data-hw-preview]")`,
      );
      scrolled = { asked: [...asked], failed: [...failed] };
      // `frameSrcdoc`: a page that refuses framing draws from its HTML; no frame load starts, so
      // none is cancelled.
      await send("Page.navigate", { url: `${server.url}inline` });
      await ready(`document.readyState === "complete" && ${fitted}`);
      await new Promise((r) => setTimeout(r, 1000));
      inline = {
        count: frames("/deny/"),
        hasSource: await evaluate(
          `[...document.querySelectorAll(".hw-catalog-preview iframe")].some((f) => f.hasAttribute("src"))`,
        ),
        failed: [...failed],
      };
      // Behind another tab the page is hidden and never paints: every tile loads at once.
      await send("Target.createTarget", { url: "about:blank" });
      hidden = await evaluate("document.hidden");
      const before = frames("/story/");
      await send("Page.navigate", { url: `${server.url}home` });
      await ready(`document.readyState === "complete"`);
      await until(() => frames("/story/") - before >= 40, "all frames in the hidden tab", {
        timeoutMs: 10_000,
        intervalMs: 100,
      });
      hiddenRequests = frames("/story/") - before;
    }, limit(60_000));
    afterAll(() => {
      page?.close();
      void server?.stop(true);
    });

    test("loads only nearby frames and starts none before the first paint", () => {
      expect(near).toBeGreaterThan(0);
      expect(near).toBeLessThan(20);
      expect(paint).toBeGreaterThan(0);
      expect(firstFrame).toBeGreaterThanOrEqual(paint);
    });

    test.each([
      ["wrapping its own ground", 0],
      ["painting its own ground", 1],
    ])("centers the preview %s and makes the canvas transparent", (_, tile) => {
      const at = tiles[tile];
      expect(Math.abs(at.dx as number)).toBeLessThan(1);
      expect(Math.abs(at.dy as number)).toBeLessThan(1);
      expect(at).toMatchObject({
        spec: "hidden",
        preview: "visible",
        ground: "rgb(255, 255, 255)",
        canvas: "rgba(0, 0, 0, 0)",
      });
    });

    test("loads the last tile when it scrolls into view", () => {
      expect(scrolled.asked).toContain("/story/39");
      expect(scrolled.failed).toEqual([]);
    });

    test("renders pages that deny framing by reading HTML for the nearby tiles", () => {
      expect(inline.count).toBeGreaterThan(0);
      expect(inline.count).toBeLessThan(20);
      expect(inline.hasSource).toBe(false);
      expect(inline.failed).toEqual([]);
    });

    test("loads every tile if a hidden document never paints", () => {
      expect(hidden).toBe(true);
      expect(hiddenRequests).toBe(40);
    });
  });

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
  describe("the provenance line", () => {
    const widths = Array.from({ length: (900 - 280) / 10 + 1 }, (_, i) => i * 10 + 280);
    const screens = new Map<number, { lines: string[]; fits: unknown }>();
    const parts = [
      "certificate-verifier src/stories",
      "@hackersandwizards/brand v2.3.1",
      "4 components",
      "17 states",
    ];
    beforeAll(async () => {
      const { renderCatalog } = await import("../catalog/render.ts");
      const shellCss = brandFallbacks(
        readFileSync(join(import.meta.dirname, "..", "catalog", "catalog.css"), "utf8"),
        BRAND_TOKENS,
      );
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
        for (const width of widths) {
          await send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 800,
            deviceScaleFactor: 1,
            mobile: false,
          });
          screens.set(width, {
            lines: (await evaluate(rows)) as string[],
            fits: await evaluate(`(${provenance}).scrollWidth <= (${provenance}).clientWidth`),
          });
        }
      } finally {
        page.close();
        void server.stop(true);
      }
    }, limit(60_000));

    test.each(widths)("wraps parts without splitting one or overflowing at %ipx", (width) => {
      const screen = screens.get(width);
      assert(screen, `the provenance measurement at ${width}px`);
      expect(screen.lines).not.toContainEqual(matchingText(/^·/));
      const rendered = screen.lines.join("\n");
      const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      expect(rendered.match(new RegExp(escaped.join("|"), "g"))).toEqual(parts);
      expect(screen.fits).toBe(true);
    });

    test("the viewport range exercises more than five wrapped layouts", () => {
      expect([...screens.values()].filter(({ lines }) => lines.length > 1).length).toBeGreaterThan(
        5,
      );
    });
  });

  describe("a marked catalog tile", () => {
    let tiles: Record<string, string | number>[];
    beforeAll(async () => {
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
        tiles = await Promise.all(stories.map((_, i) => tile(i)));
      } finally {
        page.close();
        void server.stop(true);
      }
    }, limit(60_000));

    test("a sized tile keeps its window and shows the mark against its ground", () => {
      expect(tiles[0]).toMatchObject({
        w: "1440px",
        h: "900px",
        t: matchingText(/^scale\([\d.]+\)$/),
        spec: "hidden",
        part: "visible",
        other: "visible",
        ground: "rgb(9, 9, 9)",
        canvas: "rgba(0, 0, 0, 0)",
      });
    });

    test.each([
      ["a valid selector in a sized tile", 1, "hidden"],
      ["a valid selector in a fitted tile", 2, "hidden"],
      ["a numeric value", 5, "visible"],
      ["a selector with no match", 6, "visible"],
    ])("%s shows only its marked content", (_, index, unselected) => {
      expect(tiles[index]).toMatchObject({ spec: "hidden", part: "visible", other: unselected });
    });

    test.each([
      ["around the mark", 3],
      ["around its selected part", 4],
    ])("uses the visible 300 px clipping box %s instead of the 5000 px box", (_, index) => {
      const { t, ph, pw } = tiles[index];
      const scale = /scale\(([\d.]+)\)/.exec(String(t));
      assert(scale, "the fitted preview's scale");
      expect(Number(scale[1])).toBeCloseTo(
        Math.min(0.75, ((ph as number) - 16) / 100, ((pw as number) - 16) / 300),
        2,
      );
    });
  });

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
  describe("custom-property definitions", () => {
    let dir: string;
    const config = join(import.meta.dirname, "..", "config", "stylelint.js");
    const stylelint = join(import.meta.dirname, "..", "node_modules", ".bin", "stylelint");
    const lint = (pattern: string) =>
      spawnSync(stylelint, [pattern], { cwd: dir, encoding: "utf8" });

    beforeAll(() => {
      dir = repo({
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
        "src/A.astro":
          '<style set:html={items.map((i) => i.css).join("")} />\n<style\n  set:html={x}\n/>\n<p>a</p>\n<style>\n  a { color: var(--color-nope); }\n</style>\n',
        "src/B.astro": "<style set:html={a.map((i) => i.css)} />\n<p>a</p>\n",
      });
    });

    test("a custom property brand and the repository do not define goes red", () => {
      const r = lint("src/*.css");
      expect(r.status).toBe(2);
      const out = `${r.stdout}${r.stderr}`;
      expect(out).toContain("src/bad.css");
      expect(out).toContain("--color-nope");
      expect(out).not.toContain("src/ok.css");
    });

    test("self-closing styles preserve the line of the following CSS finding", () => {
      const astro = lint("src/A.astro");
      expect(`${astro.stdout}${astro.stderr}`).toMatch(/src\/A\.astro\s+7:\d+/);
      expect(`${astro.stdout}${astro.stderr}`).not.toContain("Unknown word");
    });

    test("a self-closing Astro style has no CSS to lint", () => {
      expect(lint("src/B.astro").status).toBe(0);
    });

    test("the preset fails without the package that provides the brand properties", () => {
      const brand = join(dir, "node_modules/@hackersandwizards/brand");
      const absent = `${brand}-absent`;
      renameSync(brand, absent);
      try {
        expect(lint("src/ok.css").status).not.toBe(0);
      } finally {
        renameSync(absent, brand);
      }
    });
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

  describe("Markdown stages one blob", () => {
    let dir: string;
    beforeAll(() => {
      dir = repo({ "package.json": lintPkg, "unrelated.md": "No title.\n" });
    });
    afterEach(() => {
      prepareGit(dir, ["reset", "--mixed", "HEAD"]);
      rmSync(join(dir, "new.md"), { force: true });
    });

    test("reports the bad staged blob despite a working-tree title", () => {
      write(dir, { "new.md": "No title.\n" });
      prepareGit(dir, ["add", "--", "new.md"]);
      write(dir, { "new.md": "# Working tree title\n" });
      const result = run(dir, [bin("check-staged")]);
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain("new.md:1 error MD041");
      expect(result.out).not.toContain("unrelated.md");
      expect(result.out.trimEnd().split("\n").at(-1)).toBe(markdownRepair);
    });

    test("leaves an unstaged Markdown edit alone", () => {
      write(dir, { "new.md": "# Working tree title\n" });
      prepareGit(dir, ["add", "--", "new.md"]);
      write(dir, { "new.md": "An unstaged edit.\n" });
      const result = run(dir, [bin("check-staged")]);
      expect(result.code, result.out).toBe(0);
      expect(result.out).not.toContain(markdownRepair);
      expect(readFileSync(join(dir, "new.md"), "utf8")).toBe("An unstaged edit.\n");
    });
  });

  describe("ShellCheck reads the staged shebang, blob and .shellcheckrc", () => {
    let dir: string;
    let env: ReturnType<typeof shellcheckFixture>;
    const defaults = "# Defaults.\n";
    const disabled = "disable=SC2034\n";
    beforeAll(() => {
      dir = repo({
        "package.json": lintPkg,
        ".shellcheckrc": defaults,
        "unchanged.sh": shellScript,
      });
      env = shellcheckFixture(dir);
    });
    const stageScripts = () => {
      write(dir, { "bin/helper": shellScript, "check-lock.ts": shellScript });
      prepareGit(dir, ["add", "--", "bin/helper", "check-lock.ts"]);
    };
    afterEach(() => {
      prepareGit(dir, ["reset", "--mixed", "HEAD"]);
      write(dir, { ".shellcheckrc": defaults });
      rmSync(join(dir, "bin/helper"), { force: true });
      rmSync(join(dir, "check-lock.ts"), { force: true });
    });

    test("reports the staged shell source and ignores the unstaged config", () => {
      stageScripts();
      write(dir, { "bin/helper": "#!/usr/bin/env python\n", ".shellcheckrc": disabled });
      const result = run(dir, [bin("check-staged")], env);
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain("In bin/helper line 2");
      expect(result.out).toContain("SC2034");
      expect(result.out).not.toMatch(/unchanged\.sh|check-lock\.ts/);
      expect(result.out.trimEnd().split("\n").at(-1)).toBe(shellRepair);
    });

    test("honors the staged config without editing the working shell source", () => {
      stageScripts();
      write(dir, { ".shellcheckrc": disabled });
      prepareGit(dir, ["add", "--", ".shellcheckrc"]);
      write(dir, { ".shellcheckrc": defaults, "bin/helper": shellScript });
      const result = run(dir, [bin("check-staged")], env);
      expect(result.code, result.out).toBe(0);
      expect(result.out).not.toContain(shellRepair);
      expect(readFileSync(join(dir, "bin/helper"), "utf8")).toBe(shellScript);
    });
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
    prepareGit(dir, ["add", "--", "a.sh"]);
    const result = run(dir, [bin("check-staged")], env);
    expect(result.code, result.out).toBe(0);
    prepareGit(dir, ["add", "--", "a.sh", "lib.sh"]);
    const red = run(dir, [bin("check-staged")], env);
    expect(red.code).toBe(1);
    expect(red.out).toContain("SC2154");
  });

  test("ShellCheck follows a staged script's tracked source without a shebang", async () => {
    const main = '#!/bin/sh\n. ./lib/common.inc\nprintf "%s\\n" "$value"\n';
    const dir = repo({ "package.json": lintPkg, "lib/common.inc": "value=from_index\n" });
    const env = await realShellcheckFixture(dir);
    write(dir, { "main.sh": main });
    prepareGit(dir, ["add", "--", "main.sh"]);
    expect(checkedShell(dir, env)).toEqual({ code: 0, out: "" });
    write(dir, {
      "main.sh": "#!/bin/sh\nfalse\n",
      "lib/common.inc": "false\n",
    });
    const green = run(dir, [bin("check-staged")], env);
    expect(green.code, green.out).toBe(0);
  });

  test("ShellCheck follows transitive index sources and source directives", async () => {
    const dir = repo({
      "package.json": lintPkg,
      "lib/common.inc": '# shellcheck source="lib/value with space.inc"\n. "$1"\n',
      "lib/value with space.inc": "value=from_index\n",
    });
    const env = await realShellcheckFixture(dir);
    write(dir, { "main.sh": '#!/bin/sh\n. ./lib/common.inc\nprintf "%s\\n" "$value"\n' });
    prepareGit(dir, ["add", "--", "main.sh"]);
    const result = run(dir, [bin("check-staged")], env);
    expect(result.code, result.out).toBe(0);
  });

  test("ShellCheck lints an index source only when it is itself a staged shell input", async () => {
    const dir = repo({ "package.json": lintPkg, "scripts/lib.sh": shellStyleFinding });
    const env = await realShellcheckFixture(dir);
    write(dir, { "scripts/main.sh": "#!/bin/sh\n. ./scripts/lib.sh\n" });
    prepareGit(dir, ["add", "--", "scripts/main.sh"]);
    const green = run(dir, [bin("check-staged")], env);
    expect(green.code, green.out).toBe(0);
    write(dir, { "scripts/lib.sh": shellStyleFinding + "true\n" });
    prepareGit(dir, ["add", "--", "scripts/lib.sh"]);
    const red = run(dir, [bin("check-staged")], env);
    expect(red.code, red.out).toBe(1);
    expect(red.out).toMatch(/In scripts\/lib\.sh line 2:[\s\S]*SC2006 \(style\)/);
  });

  test("a staged item file runs admin-check, a broken one goes red", () => {
    const dir = repo({ "package.json": pkg, "docs/agent-work/items/a.md": "# Fine\n" });
    write(dir, { "node_modules/.bin/admin-check": adminCheck });
    spawnSync("chmod", ["+x", join(dir, "node_modules/.bin/admin-check")]);
    write(dir, { "docs/agent-work/items/a.md": "# broken\n" });
    sh(dir, ["add", "docs/agent-work/items/a.md"]);
    expect(run(dir, [bin("check-staged")]).code).toBe(1);
    write(dir, { "docs/agent-work/items/a.md": "# Fine again\n" });
    expect(run(dir, [bin("check-staged")]).code).toBe(1);
    sh(dir, ["add", "docs/agent-work/items/a.md"]);
    expect(run(dir, [bin("check-staged")]).code).toBe(0);
    write(dir, { "docs/agent-work/items/a.md": "# broken, unstaged\n" });
    expect(run(dir, [bin("check-staged")]).code).toBe(0);
  });

  describe("check:skills reads staged paths, including deletions and both sides of renames", () => {
    let dir: string;
    beforeAll(() => {
      dir = repo({
        "package.json": JSON.stringify({
          scaffolding: { private: true, skip: { format: "fixture", lint: "fixture" } },
          scripts: { "check:skills": `printf '%s' "$VALIDATE_SKILLS_PATHS" > scope.txt` },
        }),
        ".claude/gone.md": "x\n",
        ".claude/old.md": "# Rename this file\n",
      });
      write(dir, { ".claude/new.md": "# New\n", ".claude/half.md": "unstaged\n" });
      prepareGit(dir, ["rm", "-q", ".claude/gone.md"]);
      prepareGit(dir, ["add", ".claude/new.md"]);
      prepareGit(dir, ["config", "diff.renames", "true"]);
      prepareGit(dir, ["mv", ".claude/old.md", ".claude/renamed.md"]);
    });
    afterEach(() => rmSync(join(dir, "scope.txt"), { force: true }));

    test.each([
      ["package hook", bin("check-staged")],
      [
        "standalone hook",
        join(import.meta.dirname, "../.claude/skills/engineering/check-staged.ts"),
      ],
    ])("%s", (_, hook) => {
      const result = spawnSync(process.execPath, ["--no-env-file", hook], {
        cwd: dir,
        env: { ...process.env, VALIDATE_SKILLS_PATHS: "elsewhere/x.md" },
        encoding: "utf8",
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(join(dir, "scope.txt"), "utf8").split("\n").sort()).toEqual([
        ".claude/gone.md",
        ".claude/new.md",
        ".claude/old.md",
        ".claude/renamed.md",
      ]);
    });
  });

  const skillsScript = 'printf "%s" "$npm_package_name" > validator.txt';
  const matchingPackage = {
    name: "fixture",
    scaffolding: { private: true, skip: { format: "fixture", lint: "fixture" } },
    scripts: { "check:skills": skillsScript, other: "true" },
  };
  const scriptChanged = JSON.stringify({
    ...matchingPackage,
    scripts: { ...matchingPackage.scripts, other: "false" },
  });
  const checkSkills = (path: string, edit: Record<string, string>) => {
    const dir = repo({ "package.json": JSON.stringify(matchingPackage) });
    write(dir, { [path]: "# Staged\n" });
    prepareGit(dir, ["add", path]);
    write(dir, edit);
    const result = run(dir, [bin("check-staged")], { npm_package_name: "" });
    return { dir, result: { ...result, out: result.out.trim() } };
  };

  test.each([
    ["scripts match", {}, "fixture"],
    [
      "only package metadata differs",
      { "package.json": JSON.stringify({ ...matchingPackage, name: "edited" }) },
      "edited",
    ],
  ])("check:skills runs when %s", (_, edit, name) => {
    const { dir, result } = checkSkills(".claude/changed.md", edit);
    expect(result).toEqual({ code: 0, out: `$ ${skillsScript}` });
    expect(readFileSync(join(dir, "validator.txt"), "utf8")).toBe(name);
  });

  test.each([
    [
      "scripts differ",
      ".claude/changed.md",
      {
        code: 1,
        out: '[check:staged] package.json script differs between index and working tree: "other". Stage package.json (`git add package.json`) or discard its unstaged script edit so check:skills runs the script version being committed',
      },
    ],
    ["scripts differ outside a skill commit", "notes.md", { code: 0, out: "" }],
  ])("check:skills does not run when %s", (_, path, expected) => {
    const { dir, result } = checkSkills(path, { "package.json": scriptChanged });
    expect(result).toEqual(expected);
    expect(existsSync(join(dir, "validator.txt"))).toBe(false);
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
    prepareGit(dir, ["config", "diff.renames", "true"]);
    prepareGit(dir, ["add", "old.md"]);
    renameSync(join(dir, "old.md"), join(dir, "new.md"));
    prepareGit(dir, ["add", "-N", "new.md"]);
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
    const r = run(dir, [bin("check-staged")]);
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
    run(dir, [bin("check-staged")]);
    expect(readFileSync(join(dir, "args.txt"), "utf8").endsWith("--\n--no-config.ts\n")).toBe(true);
  });

  test.each([
    ["new file", (_dir: string) => {}],
    [
      "symlink replacement",
      (dir: string) => {
        mkdirSync(join(dir, "src"));
        symlinkSync("../eslint.config.js", join(dir, "src/a.ts"));
        prepareGit(dir, ["add", "src/a.ts"]);
        prepareGit(dir, ["commit", "-qm", "add link", "--", "src/a.ts"]);
      },
    ],
  ] as const)(
    "oxlint reads the staged source and layer policy after both change in the working tree (%s)",
    (_, arrange) => {
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
      arrange(dir);
      write(dir, { "src/replacement.ts": 'import "blocked";\n' });
      renameSync(join(dir, "src/replacement.ts"), join(dir, "src/a.ts"));
      sh(dir, ["add", "src/a.ts"]);
      write(dir, {
        "src/a.ts": "export {};\n",
        ".oxlintrc.json": JSON.stringify({ ...config, overrides: [] }),
      });
      const red = run(dir, [bin("check-staged")]);
      expect(red.out).toContain("no-restricted-imports");
      expect(red.code).toBe(1);
      sh(dir, ["add", "src/a.ts"]);
      expect(run(dir, [bin("check-staged")]).code).toBe(0);
    },
  );

  describe.each([
    ["no-self-assign", "let value = 0;\nvalue = value;\nconsole.log(value);\n"],
    ["no-useless-assignment", "let value = 0;\nvalue = 1;\nconsole.log(value);\n"],
  ])("staged %s guides", (id, broken) => {
    let dir: string;
    const clean = "console.log(1);\n";
    const repaired = "console.log(2);\n";
    beforeAll(() => {
      dir = repo({
        "package.json": JSON.stringify({
          type: "module",
          scaffolding: { private: true, skip: { format: "fixture" } },
        }),
        ".oxlintrc.json": JSON.stringify(oxlintTemplate),
        "eslint.config.js": 'export { default } from "@hackersandwizards/scaffolding/eslint";\n',
        "a.js": clean,
        "b.js": clean,
      });
      install(dir);
      symlinkSync(
        join(import.meta.dirname, "../node_modules/.bin"),
        join(dir, "node_modules/.bin"),
      );
    });
    afterEach(() => {
      write(dir, { "a.js": clean, "b.js": clean });
      prepareGit(dir, ["reset", "--mixed", "HEAD"]);
    });

    test("prints the guide for one staged finding", () => {
      write(dir, { "a.js": broken });
      prepareGit(dir, ["add", "--", "a.js"]);
      const result = run(dir, [bin("check-staged")]);
      expect(result.code, result.out).toBe(1);
      expectGuide(result.out, id);
    });

    test("prints one guide for both a whole and a partly staged file", () => {
      write(dir, { "a.js": broken, "b.js": broken });
      prepareGit(dir, ["add", "--", "a.js", "b.js"]);
      write(dir, { "b.js": repaired });
      const result = run(dir, [bin("check-staged")]);
      expect(result.code, result.out).toBe(1);
      const [findings] = result.out.split("[guide]");
      expect(findings).toContain("a.js");
      expect(findings).toContain("b.js");
      expectGuide(result.out, id);
    });

    test("prints no guide for clean staged files", () => {
      write(dir, { "a.js": repaired, "b.js": repaired });
      prepareGit(dir, ["add", "--", "a.js", "b.js"]);
      const result = run(dir, [bin("check-staged")]);
      expect(result.code, result.out).toBe(0);
      expect(result.out).not.toContain("[guide] ");
    });
  });

  const commentedOxlint = readFileSync(
    join(import.meta.dirname, "../template/.oxlintrc.json"),
    "utf8",
  ).replace("{\n", "{\n  // Keep the shared configuration.\n");
  const malformedOxlint = '{\n  // Missing value.\n  "options":\n}\n';

  test.each([
    {
      syntax: "commented",
      staged: commentedOxlint,
      working: malformedOxlint,
      code: 0,
      diagnostics: [],
    },
    {
      syntax: "malformed",
      staged: malformedOxlint,
      working: commentedOxlint,
      code: 1,
      diagnostics: ["[check:staged] oxlint: ValueExpected at position 35"],
    },
  ])(
    "check-staged reads the $syntax Oxlint configuration from the index",
    ({ staged, working, code, diagnostics }) => {
      const dir = repo({
        "package.json": JSON.stringify({
          type: "module",
          scaffolding: { private: true, skip: { format: "fixture" } },
        }),
        ".oxlintrc.json": JSON.stringify(oxlintTemplate),
        "eslint.config.js": 'export { default } from "@hackersandwizards/scaffolding/eslint";\n',
        "a.js": "console.log(1);\n",
      });
      install(dir);
      symlinkSync(
        join(import.meta.dirname, "../node_modules/.bin"),
        join(dir, "node_modules/.bin"),
      );
      write(dir, { ".oxlintrc.json": staged, "a.js": "console.log(2);\n" });
      prepareGit(dir, ["add", "--", ".oxlintrc.json", "a.js"]);
      write(dir, { ".oxlintrc.json": working });
      const result = run(dir, [bin("check-staged")]);
      expect(result.code, result.out).toBe(code);
      const actual = Array.from(
        result.out.matchAll(/^\[check:staged\] oxlint:.*$/gm),
        ([line]) => line,
      );
      expect(actual).toEqual(diagnostics);
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
      return run(dir, [bin("check-staged")]);
    };
    expect(staged({}).code).toBe(1);
    expect(staged({ coupling: "a fixture outside" }).code).toBe(0);
  });

  test("a staged item file without admin-check installed is refused", () => {
    const dir = repo({ "package.json": pkg, "docs/agent-work/items/a.md": "# Fine\n" });
    write(dir, { "docs/agent-work/items/a.md": "changed\n" });
    sh(dir, ["add", "docs/agent-work/items/a.md"]);
    const r = run(dir, [bin("check-staged")]);
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
    const r = run(dir, [bin("check-staged")]);
    expect(r.out).not.toContain("EPIPE");
    expect(r.out).toContain("[check:staged] prettier: big.txt as staged");
    expect(r.code).toBe(1);
  });

  test.each([
    {
      tools: "both are declared",
      manifest: { devDependencies: { prettier: "3", eslint: "10" } },
      code: 1,
      report: "prettier not installed",
    },
    { tools: "neither is declared", manifest: {}, code: 1, report: "prettier not installed" },
    {
      tools: "format is skipped",
      manifest: { scaffolding: { skip: { format: "none" } } },
      code: 1,
      report: "eslint not installed",
    },
    {
      tools: "format has an empty reason",
      manifest: { scaffolding: { skip: { format: "", lint: "none" } } },
      code: 1,
      report: "prettier not installed",
    },
    {
      tools: "format has a false reason",
      manifest: { scaffolding: { skip: { format: false, lint: "none" } } },
      code: 1,
      report: "prettier not installed",
    },
    {
      tools: "format has an object reason",
      manifest: { scaffolding: { skip: { format: {}, lint: "none" } } },
      code: 1,
      report: "prettier not installed",
    },
    {
      tools: "both have reasons",
      manifest: { scaffolding: { skip: { format: "none", lint: "none" } } },
      code: 0,
      report: /^$/,
    },
  ] as const)(
    "check-staged resolves required Prettier and ESLint tools when $tools",
    ({ manifest, code, report }) => {
      const dir = repo({ "package.json": JSON.stringify(manifest) });
      write(dir, { "a.ts": "export {};\n" });
      prepareGit(dir, ["add", "a.ts"]);
      const result = run(dir, [bin("check-staged")]);
      expect(result.code, result.out).toBe(code);
      expect(result.out).toMatch(report);
    },
    limit(20_000),
  );

  test(
    "uses the installed Prettier when lint is skipped",
    () => {
      const dir = repo({
        "package.json": JSON.stringify({ scaffolding: { skip: { lint: "none" } } }),
      });
      const prettier = "node_modules/.bin/prettier";
      write(dir, { [prettier]: "#!/bin/sh\nexit 0\n", "a.ts": "export {};\n" });
      chmodSync(join(dir, prettier), 0o755);
      prepareGit(dir, ["add", "a.ts"]);
      const result = run(dir, [bin("check-staged")]);
      expect(result.code, result.out).toBe(0);
      expect(result.out).not.toContain("not installed");
    },
    limit(20_000),
  );

  describe("stylelint", () => {
    const stylelint = join(import.meta.dirname, "..", "node_modules/stylelint/bin/stylelint.mjs");
    const html = join(import.meta.dirname, "..", "node_modules/postcss-html/lib/index.js");
    const bad = "a { color: #ggg; }\n";
    const installStylelint = (dir: string) => {
      mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
      symlinkSync(stylelint, join(dir, "node_modules/.bin/stylelint"));
    };
    const staged = (
      files: Record<string, string>,
      styles: unknown,
      arrange: (dir: string) => void,
    ) => {
      const dir = repo({
        "package.json": JSON.stringify({
          type: "module",
          scaffolding: { skip: { format: "none", lint: "none", styles } },
        }),
        "stylelint.config.js": `export default { overrides: [{ files: ["**/*.astro"], customSyntax: "${html}" }], rules: { "color-no-invalid-hex": true } };\n`,
        "nested/.stylelintrc.json": "{}",
      });
      arrange(dir);
      write(dir, files);
      sh(dir, ["add", ...Object.keys(files)]);
      return { dir, ...run(dir, [bin("check-staged")]) };
    };

    test.each<{
      scenario: string;
      files: Record<string, string>;
      reason: string | undefined;
      code: number;
      report: RegExp;
    }>([
      {
        scenario: "a CSS file is staged",
        files: { "a.css": bad },
        reason: undefined,
        code: 1,
        report: /stylelint not installed/,
      },
      {
        scenario: "only hidden CSS and a TypeScript file are staged",
        files: { "a.ts": "export {};\n", ".x/a.css": bad },
        reason: undefined,
        code: 0,
        report: /^$/,
      },
      {
        scenario: "there is a skip reason",
        files: { "a.css": bad },
        reason: "none",
        code: 0,
        report: /^$/,
      },
      {
        scenario: "the skip reason is blank",
        files: { "a.css": bad },
        reason: " ",
        code: 1,
        report: /stylelint not installed/,
      },
    ])(
      "resolves the required binary when $scenario",
      ({ files, reason, code, report }) => {
        const result = staged(files, reason, () => {});
        expect(result.code, result.out).toBe(code);
        expect(result.out).toMatch(report);
      },
      limit(20_000),
    );

    test(
      "uses root rules for all staged styles, including Astro and a nested CSS file",
      () => {
        const red = staged(
          {
            "a.css": bad,
            "a.ts": "#ggg\n",
            "B.astro": `<p>a</p>\n<style>\n  ${bad}</style>\n`,
            "nested/c.css": bad,
            ".storybook/d.css": bad,
          },
          undefined,
          installStylelint,
        );
        expect(red.code, red.out).toBe(1);
        expect(red.out).not.toMatch(/a\.ts:|d\.css/);
        expect(
          Array.from(
            red.out.matchAll(
              /(?:a\.css: line 1, col 12, error - Invalid hex color|B\.astro: line 3, col 14, error - Invalid hex color|nested\/c\.css: line 1, col 12)/g,
            ),
            (match) => match[0],
          ).sort(),
        ).toEqual([
          "B.astro: line 3, col 14, error - Invalid hex color",
          "a.css: line 1, col 12, error - Invalid hex color",
          "nested/c.css: line 1, col 12",
        ]);
      },
      limit(20_000),
    );

    test(
      "uses the staged CSS blob after an unstaged repair",
      () => {
        const ok = staged({ "a.css": "a { color: #fff; }\n" }, undefined, installStylelint);
        expect(ok.code).toBe(0);
        write(ok.dir, { "a.css": bad });
        sh(ok.dir, ["add", "a.css"]);
        write(ok.dir, { "a.css": "a { color: #000; }\n" });
        const partial = run(ok.dir, [bin("check-staged")]);
        expect(partial).toEqual({
          code: 1,
          out: containingText("[check:staged] stylelint: a.css as staged"),
        });
      },
      limit(20_000),
    );
  });

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
    expect(run(dir, [bin("check-staged")]).code).toBe(1);
    commit({ format: "committed" });
    write(dir, { "package.json": manifest({}) });
    expect(run(dir, [bin("check-staged")]).code).toBe(0);
    commit({});
    sh(dir, ["rm", "-q", "--cached", "a.ts"]);
    // A submodule's new commit, with the submodule dirty, is no file for prettier.
    const sub = repo({ "x.md": "x\n" });
    sh(dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"]);
    sh(dir, ["commit", "-qm", "sub"]);
    sh(join(dir, "sub"), ["commit", "-q", "--allow-empty", "-m", "next"]);
    write(dir, { "sub/x.md": "dirty\n", "docs/agent-work/items/a.md": "# A\n" });
    sh(dir, ["add", "sub", "docs/agent-work/items/a.md"]);
    const r = run(dir, [bin("check-staged")]);
    expect(r).toEqual({ code: 0, out: "" });
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
    expect(run(dir, [bin("check-staged")]).out).toContain("admin-check not installed");
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
  function consumer(dependencies: Record<string, string>, scripts: Record<string, string>) {
    const pkg = { name: "c", private: true, scripts, dependencies };
    const dir = repo({ "package.json": `${JSON.stringify(pkg, null, 2)}\n` }, false);
    const env = { ...process.env, BUN_INSTALL_CACHE_DIR: cacheDir };
    prepareCommand(dir, ["bun", "install"], env);
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

  describe("raising each pin to the newest tag in dependency order", () => {
    let base: string;
    let raised: ReturnType<typeof run>;
    let committed: ReturnType<typeof run>;
    let pin: string;
    let installed: unknown;
    let revisions: string;
    let subject: string;
    let status: string;
    let repeated: ReturnType<typeof run>;

    beforeAll(() => {
      base = packages();
      const dir = consumer(
        {
          "@hackersandwizards/b": `git+file://${base}/b#v1.0.0`,
          "@hackersandwizards/a": `git+file://${base}/a#v1.0.0`,
        },
        { check: "true" },
      );
      raised = run(dir, [bin("raise-pins")], identity);
      pin = readFileSync(join(dir, "package.json"), "utf8");
      installed = version(dir, "a");
      revisions = sh(dir, ["rev-list", "--count", "HEAD"]).stdout.toString().trim();
      sh(dir, ["checkout", "--", "package.json", "bun.lock"]);
      committed = run(dir, [bin("raise-pins"), "--commit"], identity);
      subject = sh(dir, ["log", "-1", "--format=%s"]).stdout.toString().trim();
      status = sh(dir, ["status", "--porcelain"]).stdout.toString();
      repeated = run(dir, [bin("raise-pins"), "--commit"], identity);
    });

    test("installs and gates the raised pins without committing by default", () => {
      expect(raised.code).toBe(0);
      expect(lines(raised.out, "raise-pins")).toEqual([
        "[raise-pins] @hackersandwizards/a: v1.0.0 -> v1.10.0",
        "[raise-pins] @hackersandwizards/b: v1.0.0 -> v1.10.0",
        "[raise-pins] gate green with a v1.10.0, b v1.10.0",
      ]);
      expect(pin).toContain(`${base}/a#v1.10.0"`);
      expect(installed).toBe("1.10.0");
      expect(revisions).toBe("1");
    });

    test("--commit leaves a named commit and a clean tree", () => {
      expect(committed.code).toBe(0);
      expect(subject).toBe("pins: raise a v1.10.0, b v1.10.0");
      expect(status).toBe("");
    });

    test("repeating the committed raise runs no gate", () => {
      expect(lines(repeated.out, "raise-pins")).toContain(
        "[raise-pins] nothing raised, so the gate did not run",
      );
    });
  });

  test("selects a pin by its repository's owner, not its name: an unscoped one of ours rises, a foreign one stays", () => {
    const ours = packages(["u"], "");
    const foreign = packages(["f"], "", "someone");
    const dir = consumer(
      { u: `git+file://${ours}/u#v1.0.0`, f: `git+file://${foreign}/f#v1.0.0` },
      { check: "true" },
    );
    const r = run(dir, [bin("raise-pins"), "--commit"], identity);
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
    const dir = consumer(
      {
        "@hackersandwizards/b": `git+file://${base}/b#v1.0.0`,
        "@hackersandwizards/a": `git+file://${base}/a#v1.0.0`,
      },
      { check: "true" },
    );
    renameSync(join(base, "b"), join(base, "b-gone"));
    const r = run(dir, [bin("raise-pins"), "--commit"], identity);
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
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  describe("invalid and capped fetch timeouts", () => {
    let remote: string;
    beforeAll(() => {
      remote = join(packages(["a"]), "a");
    });
    test.each(["-1", "1e10", "99999999999"])(
      "gives Git time to read local tags under %s",
      async (wait) => {
        const saved = { ...process.env };
        try {
          process.env.SCAFFOLDING_FETCH_WAIT_S = wait;
          expect(await newestTag(remote)).toBe("v1.10.0");
        } finally {
          process.env = saved;
        }
      },
    );
  });

  test("a scaffolding raise commits what check-structure --fix wrote, unless --fix rewrote an edit", () => {
    const base = packages(["scaffolding"]);
    const fix = { check: "true", "check-structure": "echo fixed > skeleton.txt" };
    const dir = consumer(
      { "@hackersandwizards/scaffolding": `git+file://${base}/scaffolding#v1.0.0` },
      fix,
    );
    // git status lists an untracked nested repository as a directory.
    sh(dir, ["init", "-q", "nested"]);
    expect(run(dir, [bin("raise-pins"), "--commit"], identity).code).toBe(0);
    expect(sh(dir, ["show", "--name-only", "--format=", "HEAD"]).stdout.toString()).toContain(
      "skeleton.txt",
    );

    const edited = consumer(
      { "@hackersandwizards/scaffolding": `git+file://${base}/scaffolding#v1.0.0` },
      { ...fix, "check-structure": "echo fixed > edited.txt" },
    );
    write(edited, { "edited.txt": "committed\n" });
    sh(edited, ["add", "edited.txt"]);
    sh(edited, ["commit", "-qm", "edited"]);
    write(edited, { "edited.txt": "someone's edit\n" });
    const r = run(edited, [bin("raise-pins"), "--commit"], identity);
    expect(r.code).toBe(1);
    expect(r.out).toContain("check-structure --fix rewrote edited.txt");
    expect(sh(edited, ["log", "-1", "--format=%s"]).stdout.toString().trim()).toBe("edited");
  });

  test("a commit its hook refuses leaves nothing staged and says so", () => {
    const dir = consumer(
      { "@hackersandwizards/a": `git+file://${packages(["a"])}/a#v1.0.0` },
      { check: "true" },
    );
    write(dir, { "hooks/pre-commit": "#!/bin/sh\nexit 1\n" });
    chmodSync(join(dir, "hooks/pre-commit"), 0o755);
    sh(dir, ["config", "core.hooksPath", "hooks"]);
    const r = run(dir, [bin("raise-pins"), "--commit"], identity);
    expect(r.code).toBe(1);
    expect(r.out).toContain("[raise-pins] the commit failed (above)");
    expect(sh(dir, ["diff", "--cached", "--name-only"]).stdout.toString()).toBe("");
  });

  test("a red gate commits nothing; an uncommitted package.json stops it before any change", () => {
    const dir = consumer(
      { "@hackersandwizards/a": `git+file://${packages()}/a#v1.0.0` },
      { check: "exit 1" },
    );
    const r = run(dir, [bin("raise-pins"), "--commit"], identity);
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "[raise-pins] nothing committed: package.json and bun.lock keep the raise",
    );
    expect(sh(dir, ["rev-list", "--count", "HEAD"]).stdout.toString().trim()).toBe("1");
    const dirty = run(dir, [bin("raise-pins")], identity);
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
    const r = run(repo({ "src/A.astro": page, "package.json": "{}" }), [bin("check-spaces")]);
    expect(r.code).toBe(1);
    expect(
      lines(r.out, "spaces").map((l) =>
        defined(l.match(/line (\d+):.*?meets <(\w+)>/), "spaces finding line").slice(1),
      ),
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
    const empty = run(repo({ "src/B.astro": "---\n---\n<code>x</code>\n", "package.json": "{}" }), [
      bin("check-spaces"),
    ]);
    expect(empty.code).toBe(0);
  });

  describe("inline spaces around tags and expressions", () => {
    const flagged = (body: string) =>
      lines(
        run(repo({ "src/A.astro": `<p>\n${body}\n</p>\n`, "package.json": "{}" }), [
          bin("check-spaces"),
        ]).out,
        "spaces",
      ).length;
    test.each([
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
    ])("reports one lost space for %#", (body) => {
      expect(flagged(body), body).toBe(1);
    });

    test.each([
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
    ])("preserves spacing for %#", (body) => {
      expect(flagged(body), body).toBe(0);
    });
  });

  describe("Astro's compressHTML setting", () => {
    const off = "export default {\n  compressHTML: false,\n};\n";
    test.each([
      ["all false", { "astro.config.mjs": off, "catalog/astro.config.ts": off }, 0],
      [
        "all booleans",
        {
          "astro.config.mjs": off,
          "catalog/astro.config.ts": "export default { compressHTML: true };\n",
        },
        0,
      ],
      ["explicit jsx", { "astro.config.mjs": 'export default { compressHTML: "jsx" };\n' }, 1],
      [
        "missing in one config",
        { "astro.config.mjs": off, "catalog/astro.config.ts": "export default {};\n" },
        1,
      ],
      [
        "a commented setting",
        { "astro.config.mts": "// compressHTML: false\nexport default {};\n" },
        1,
      ],
    ] as const)("checks spacing for %s", (_, configs, expected) => {
      const result = run(repo({ "src/A.astro": page, "package.json": "{}", ...configs }), [
        bin("check-spaces"),
      ]);
      expect(result.code, result.out).toBe(expected);
    });
  });

  describe("a package that ships components", () => {
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
          [bin("check-spaces")],
        ).out,
        "spaces",
      ).map((l) => defined(l.match(/\] ([^:]+):/), "spaces finding path")[1]);
    // The pack list and exported imports are the components a consumer can use.
    test.each([
      ["no published inputs", {}, []],
      ["published files", { files: ["components", "README.md"] }, ["components/A.astro"]],
      [
        "an exported component",
        { exports: { "./A": { default: "./components/A.astro" } } },
        ["components/A.astro", "lib/B.astro"],
      ],
      [
        "wildcard component exports",
        { exports: { "./parts/*": "./components/*" } },
        ["components/A.astro", "lib/B.astro"],
      ],
      ["only a non-component export", { exports: { "./x": "./x.ts" } }, []],
    ] as const)("reads the components of %s", (_, pkg, expected) => {
      expect(flagged(pkg)).toEqual(expected);
    });

    const files = { files: ["components"] };
    const inline = [
      "  <a>x</a>\n  {cond && <b>y</b>}",
      '  <span>{chapter.title}</span>\n  {toc[i] > 0 && <span class="page">{toc[i]}</span>}',
      "  <a>x</a>\n  {cond && <b t={{ a: 1 }}>y</b>}",
      "  contents\n  {n > 0 && <span>{n}</span>}",
    ];
    // These expressions need the package scan at jsx when the package itself keeps the space.
    describe.each([
      ["an uncompressed package", off, ["components/A.astro"]],
      ["default JSX compression", {}, []],
    ] as const)("an inline expression in %s", (_, config, expected) => {
      test.each(inline)("checks packaged spacing for %#", (body) => {
        expect(flagged(files, body, config), body).toEqual(expected);
      });
    });

    test.each([
      "  <a>x</a>\n  {cond && <div>y</div>}",
      "  <a>x</a>\n  {cond && <div><span>y</span></div>}",
      "  <a>x</a>\n  {cond && (\n    <b>y</b>\n  )}",
      "  {cond && <b>y</b>}\n  <a>x</a>",
    ])("keeps layout expressions out of the package findings for %#", (body) => {
      expect(flagged(files, body), body).toEqual([]);
    });
  });

  test("an allow entry keeps a flex case; a stale one is red", () => {
    const allowed = (text: string) =>
      repo({
        "src/A.astro": "<h2>\n  <span></span>\n  Running\n</h2>\n",
        "package.json": JSON.stringify({
          scaffolding: { allow: [{ check: "spaces", path: "src/*.astro", text, reason: "flex" }] },
        }),
      });
    expect(run(allowed("<span></span>"), [bin("check-spaces")]).code).toBe(0);
    expect(run(allowed("nothing"), [bin("check-spaces")]).out).toContain(
      "allow entry matches nothing: remove this stale entry (or unused path/text item) from package.json scaffolding.allow",
    );
  });
});

describe("check-names", () => {
  const source = "function findEntry() { return 1; }\n";
  const namesFixture = (
    files: Record<string, string>,
    ignorePatterns = oxlintTemplate.ignorePatterns,
  ) => {
    const dir = repo({
      ".oxlintrc.json": JSON.stringify({ ...oxlintTemplate, ignorePatterns }),
      ...files,
    });
    install(dir);
    return dir;
  };

  test("one module-scope name shared by three files gives one finding listing every file", () => {
    const dir = namesFixture({
      "a.ts": source,
      "b.js": "export function findEntry() { return 2; }\n",
      "c.mjs": "let findEntry = function inner() { return 3; };\n",
    });
    const result = run(dir, [bin("check-names")]);
    expect(result.code, result.out).toBe(1);
    expect(lines(result.out, "names")).toEqual([
      "[names] a.ts: function `findEntry` is also declared in b.js, c.mjs",
    ]);
    expectGuideAfter(result.out, "duplicate-function-name", "is also declared in b.js, c.mjs");
  });

  test("two module-scope arrow bindings are reported", () => {
    const dir = namesFixture({
      "a.ts": "export const findEntry = () => 1;\n",
      "b.ts": "const findEntry = (() => 2);\n",
    });
    const result = run(dir, [bin("check-names")]);
    expect(result.code, result.out).toBe(1);
    expect(lines(result.out, "names")).toEqual([
      "[names] a.ts: function `findEntry` is also declared in b.ts",
    ]);
    expectGuide(result.out, "duplicate-function-name");
  });

  test("a var hoisted to module scope counts and a block-local const passes", () => {
    const dir = namesFixture({
      "a.ts": source,
      "b.ts": "if (ready) { var findEntry = () => 2; }\n",
    });
    const result = run(dir, [bin("check-names")]);
    expect(result.code, result.out).toBe(1);
    expect(lines(result.out, "names")).toEqual([
      "[names] a.ts: function `findEntry` is also declared in b.ts",
    ]);
    expectGuide(result.out, "duplicate-function-name");
    write(dir, { "b.ts": "if (ready) { const findEntry = () => 2; findEntry(); }\n" });
    expect(run(dir, [bin("check-names")])).toEqual({ code: 0, out: "" });
  });

  test("tests, nested declarations, excluded files, and framework names pass", () => {
    const dir = namesFixture(
      {
        "a.ts": source + "export function GET() { return 1; }\n",
        "a.test.ts": source,
        "test/helpers.ts": source,
        "b.d.mts": source,
        "b.stories.ts": source,
        "b.min.js": source,
        "dist/b.js": source,
        "vendor/b.js": source,
        "x/public/b.js": source,
        "generated.js": source,
        "b.ts":
          "export function GET() { function findEntry() { return 2; } return findEntry(); }\n",
      },
      [...oxlintTemplate.ignorePatterns, "generated.js"],
    );
    expect(run(dir, [bin("check-names")])).toEqual({ code: 0, out: "" });
  });

  test("verbatim installed skeleton files are exempt while modified copies are checked", () => {
    const path = ".githooks/check-lock-record.ts";
    const skeleton = readFileSync(join(import.meta.dirname, "../template", path), "utf8");
    const dir = namesFixture(
      {
        [path]: skeleton,
        "a.ts": "export function parseHolder(raw: string) { return raw; }\n",
      },
      oxlintTemplate.ignorePatterns.filter((pattern) => pattern !== "/.githooks/**"),
    );
    expect(run(dir, [bin("check-names")])).toEqual({ code: 0, out: "" });
    write(dir, { [path]: skeleton + "\n// Local behavior.\n" });
    const result = run(dir, [bin("check-names")]);
    expect(result.code, result.out).toBe(1);
    expect(lines(result.out, "names")).toEqual([
      "[names] .githooks/check-lock-record.ts: function `parseHolder` is also declared in a.ts",
    ]);
    expectGuide(result.out, "duplicate-function-name");
  });

  test("the package itself has unique production function names", () => {
    expect(run(join(import.meta.dirname, ".."), [bin("check-names")])).toEqual({
      code: 0,
      out: "",
    });
  });
});

const exerciseNames = "src/**/exercises/**";
const exerciseSource = "function exerciseEntry() {}\n";
const namesSettings = (names: unknown) => ({ settings: { scaffolding: { names } } });
const exerciseExemption = namesSettings({
  [exerciseNames]: "The exercise and solution use the same names.",
});

test.each([
  {
    title: "skips both exercise copies and a name they share with an included file",
    config: exerciseExemption,
    expectedCode: 0,
    expectedFindings: [],
  },
  {
    title: "reports duplicates between included files even with an exemption",
    config: exerciseExemption,
    extraFiles: { "src/other.mjs": exerciseSource },
    expectedCode: 1,
    expectedFindings: [
      "[names] src/live.mjs: function `exerciseEntry` is also declared in src/other.mjs",
    ],
  },
  {
    title: "reports the same exercise pair without an exemption",
    config: {},
    expectedCode: 1,
    expectedFindings: [
      "[names] src/exercises/solution/start.mjs: function `exerciseEntry` is also declared in src/exercises/start.mjs, src/live.mjs",
    ],
  },
  {
    title: "fails for an empty or non-string reason",
    config: namesSettings({ [exerciseNames]: "", "src/live.mjs": false }),
    expectedCode: 1,
    expectedFindings: [
      '[names] .oxlintrc.json: settings.scaffolding.names["src/**/exercises/**"] must be a non-blank reason string',
      '[names] .oxlintrc.json: settings.scaffolding.names["src/live.mjs"] must be a non-blank reason string',
    ],
  },
  {
    title: "fails when names is not an object",
    config: namesSettings([]),
    expectedCode: 1,
    expectedFindings: [
      "[names] .oxlintrc.json: settings.scaffolding.names must be an object mapping repository-relative globs to non-blank reason strings",
    ],
  },
])("check-names $title", ({ config, extraFiles, expectedCode, expectedFindings }) => {
  using fixture = testDirectory();
  const dir = repo(
    {
      ".oxlintrc.json": `// Repository lint settings\n${JSON.stringify({ ...oxlintTemplate, ...config })}\n`,
      "src/exercises/start.mjs": exerciseSource,
      "src/exercises/solution/start.mjs": exerciseSource,
      "src/live.mjs": exerciseSource,
      ...extraFiles,
    },
    true,
    fixture.folder,
  );
  install(dir);
  const result = run(dir, [bin("check-names")]);
  expect(result.code, result.out).toBe(expectedCode);
  expect(lines(result.out, "names")).toEqual(expectedFindings);
});

describe("check-cycles", () => {
  const cycle = (files: Record<string, string>) => run(repo(files), [bin("check-cycles")]);
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
    const r = run(dir, [bin("check-cycles")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${page} -> src/pages/value.ts -> ${page}`);
  });

  describe("the import graph includes untracked files and excludes ignored files", () => {
    let dir: string;
    let mirrorCache: string;
    beforeAll(() => {
      dir = repo({
        ".gitignore": "node_modules\n/ignored/\n",
        "a.ts": 'import "./b.ts";\n',
        "b.ts": 'import "./a.ts";\n',
      });
      mirrorCache = join(dir, "node_modules", ".cache", "scaffolding");
    });
    const addInputs = (prefix = "") =>
      write(dir, {
        [prefix + page]: "---\nimport './missing-astro.ts';\n---\n<p>Page</p>\n",
        [prefix + "untracked.ts"]: 'import "./missing-ts.ts";\n',
      });
    afterEach(() => {
      prepareGit(dir, ["reset", "--mixed", "HEAD"]);
      rmSync(join(dir, page), { force: true });
      rmSync(join(dir, "untracked.ts"), { force: true });
      rmSync(join(dir, "ignored"), { force: true, recursive: true });
      rmSync(mirrorCache, { force: true, recursive: true });
    });

    test("reports a tracked TypeScript cycle without creating an Astro mirror", () => {
      const result = run(dir, [bin("check-cycles")]);
      expect(result.code).toBe(1);
      expect(result.out).toContain("a.ts -> b.ts -> a.ts");
      expect(existsSync(mirrorCache)).toBe(false);
    });

    test("skips ignored imports without creating an Astro mirror", () => {
      addInputs("ignored/");
      const result = run(dir, [bin("check-cycles")]);
      expect(result.out).toContain("a.ts -> b.ts -> a.ts");
      expect(result.out).not.toContain("missing-");
      expect(existsSync(mirrorCache)).toBe(false);
    });

    const expectUnresolvedImports = () => {
      const result = run(dir, [bin("check-cycles")]);
      expect(result.code).toBe(1);
      expect(result.out).toContain("a.ts -> b.ts -> a.ts");
      expect(new Set(result.out.match(/\.\/missing-(?:astro|ts)\.ts/g))).toEqual(
        new Set(["./missing-astro.ts", "./missing-ts.ts"]),
      );
      expect(readdirSync(mirrorCache)).toEqual([]);
    };

    test("reports untracked unresolved imports and removes the Astro mirror", () => {
      addInputs();
      expectUnresolvedImports();
    });

    test("reports staged unresolved imports and removes the Astro mirror", () => {
      addInputs();
      prepareGit(dir, ["add", "--", page, "untracked.ts"]);
      expectUnresolvedImports();
    });
  });

  test("an Astro compiler error names the source and the mirror is removed", () => {
    const dir = repo({ [page]: "---\nconst =\n---\n<p>Page</p>\n" });
    const r = run(dir, [bin("check-cycles")]);
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
    const lib = join(import.meta.dirname, "..", "lib");
    mkdirSync(join(installation, "lib"));
    symlinkSync(join(lib, "guides.ts"), join(installation, "lib", "guides.ts"));
    for (const file of ["import-graph.ts", "import-scan.ts", "astro-imports.ts"])
      copyFileSync(join(lib, file), join(installation, "lib", file));
    symlinkSync(join(lib, "repo.ts"), join(installation, "lib", "repo.ts"));
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
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        ),
        encoding: "utf8",
      });
    expect(check().status).toBe(0);
    write(dir, { [page]: "<p>Page</p>\n" });
    prepareGit(dir, ["add", "--", page]);
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[cycles] package.json: cannot load @astrojs/compiler-rs");
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });

  test("the Astro mirror cannot write through a cache symlink outside the checkout", () => {
    const dir = repo({ [page]: "<p>Page</p>\n" });
    const outside = temp();
    symlinkSync(outside, join(dir, "node_modules"), "dir");
    const r = run(dir, [bin("check-cycles")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "the cycles cache path contains a symlink: replace node_modules/.cache/scaffolding (or a symlinked parent) with a real directory by removing the symlink and running bun install",
    );
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

  describe.each<{
    source: string;
    open: string;
    close: string;
    extraImports: readonly string[];
    extraFiles: Record<string, string>;
  }>([
    { source: "src/pages/index.ts", open: "", close: "\n", extraImports: [], extraFiles: {} },
    {
      source: page,
      open: "---\n",
      close: "\n---\n<p>Page</p>\n",
      extraImports: ['import "./component.astro";'],
      extraFiles: {
        "src/pages/component.astro": "<p>Component</p>\n",
      },
    },
  ])("import checks in $source", ({ source, open, close, extraImports, extraFiles }) => {
    const sourceWithImports = (imports: string) => `${open}${imports}${close}`;

    describe("sibling imports", () => {
      let checkout: string;
      const inside = sourceWithImports('import "./inside.ts";\nimport "installed-package";');
      beforeAll(() => {
        const parent = temp();
        const dir = repo({
          "tsconfig.json": '{"compilerOptions":{"paths":{"@sibling/*":["../sibling/*"]}}}',
          [source]: inside,
          "src/pages/inside.ts": "export const value = 1;\n",
        });
        write(parent, {
          "sibling/value.ts": 'import "./loop.ts";\nexport const value = 2;\n',
          "sibling/loop.ts": 'import "./value.ts";\n',
          "node_modules/installed-package/index.js": 'import "./missing.js";\n',
        });
        checkout = join(parent, "checkout");
        renameSync(dir, checkout);
      });
      afterEach(() => write(checkout, { [source]: inside }));
      test("passes without an import leaving the checkout", () => {
        expect(run(checkout, [bin("check-cycles")])).toEqual({ code: 0, out: "" });
      });
      test.each(["../../../sibling/value.ts", "@sibling/value"])("rejects %s", (specifier) => {
        write(checkout, { [source]: sourceWithImports(`import "${specifier}";`) });
        const r = run(checkout, [bin("check-cycles")]);
        expect(r.code).toBe(1);
        expect(lines(r.out, "cycles")).toEqual([
          `[cycles] ${source}: import leaves the checkout: take another repository's code from its published package, never from a sibling path (${specifier} -> ../sibling/value.ts)`,
        ]);
      });
    });

    test("checks relative files on disk and lets unresolved packages and aliases pass", () => {
      const imports = [
        'import "./style.css";',
        'import "./icon.svg?raw";',
        'import "./data.json";',
        'import "unresolvable-package/entry";',
        'import "@/unresolvable-alias";',
        ...extraImports,
      ].join("\n");
      const dir = repo({
        ".gitignore": "node_modules\n/src/pages/*.css\n/src/pages/*.svg\n/src/pages/*.json\n",
        [source]: sourceWithImports(imports),
        ...extraFiles,
      });
      write(dir, {
        "src/pages/style.css": "p { color: red; }\n",
        "src/pages/icon.svg": "<svg/>\n",
        "src/pages/data.json": "{}\n",
      });
      expect(run(dir, [bin("check-cycles")])).toEqual({ code: 0, out: "" });

      rmSync(join(dir, "src/pages/icon.svg"));
      write(dir, { [source]: sourceWithImports(`${imports}\nimport "../missing.ts";`) });
      const r = run(dir, [bin("check-cycles")]);
      expect(r.code).toBe(1);
      expect(lines(r.out, "cycles")).toEqual([
        `[cycles] ${source}: relative import does not resolve to a file: fix the typo, add the missing file or extension, or remove the dead import (../missing.ts)`,
        `[cycles] ${source}: relative import does not resolve to a file: fix the typo, add the missing file or extension, or remove the dead import (./icon.svg?raw)`,
      ]);
    });
  });

  test("a submodule's cycle is its own repository's, and a repository without code passes", () => {
    const loop = {
      "a.ts": 'import { b } from "./b.ts";\nexport const a = (): number => b();\n',
      "b.ts": 'import { a } from "./a.ts";\nexport const b = (): number => a();\n',
    };
    const dir = repo({ "README.md": "x\n" });
    expect(run(dir, [bin("check-cycles")]).code).toBe(0);
    sh(dir, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      repo(loop),
      "vendor/in",
    ]);
    expect(run(dir, [bin("check-cycles")]).code).toBe(0);
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
    prepareCommand(dir, [process.execPath, "install"]);
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
    const r = run(dir, [bin("check-licenses")]);
    expect(r.code).toBe(1);
    const red = lines(r.out, "check-licenses").map((line) => {
      const match = line.match(/^\S+ @?[^@]+/);
      assert(match, line);
      return match[0];
    });
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
    expect(run(installed({ planted: license("GPL-3.0-only") }), [bin("check-licenses")]).code).toBe(
      1,
    );
    expect(run(installed({ planted: license("MIT") }), [bin("check-licenses")]).code).toBe(0);
  });

  const pinned = { license: "Standard 'no charge' license", reason: "dev only" };
  const pinnedMismatch =
    'scaffolding.licenses["gsap"] pins "MIT", installed is "Standard \'no charge\' license": review the new licence with `bun pm why gsap`, then either remove the stale entry (if the new licence is on the allow list), replace the package, or update the pinned "license" and "reason" in package.json';
  const reasonRequired =
    'scaffolding.licenses["gsap"] needs a license string and a reason: set { "license": "<SPDX>", "reason": "<conveyed or not, who decided>" } in package.json, or remove the entry if the package is not needed';
  test.each([
    ["exact package", { gsap: pinned }],
    ["wildcard", { "gs*": pinned }],
  ])(
    "accepts the %s licence exception without findings",
    (_, licenses) => {
      expect(
        run(installed({ gsap: license("Standard 'no charge' license") }, { licenses }), [
          bin("check-licenses"),
        ]),
      ).toEqual({ code: 0, out: "" });
    },
    limit(20_000),
  );

  test.each([
    ["changed licence", { gsap: { ...pinned, license: "MIT" } }, pinnedMismatch],
    ["missing reason", { gsap: { license: pinned.license } }, reasonRequired],
    ["non-string reason", { gsap: { ...pinned, reason: {} } }, reasonRequired],
    ["non-string licence", { gsap: { ...pinned, license: true } }, reasonRequired],
    [
      "stale entry",
      { gsap: pinned, "left-pad": { license: "MIT", reason: "gone" } },
      'scaffolding.licenses["left-pad"] matches no installed package',
    ],
  ])(
    "rejects the licence exception for %s",
    (_, licenses, diagnostic) => {
      const result = run(
        installed({ gsap: license("Standard 'no charge' license") }, { licenses }),
        [bin("check-licenses")],
      );
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain(diagnostic);
    },
    limit(20_000),
  );

  test("fails closed: no node_modules, an empty one, a missing lockfile", () => {
    const dir = installed({ fine: license("MIT") });
    renameSync(join(dir, "node_modules"), join(dir, "node_modules-away"));
    const missing = run(dir, [bin("check-licenses")]);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("run bun install");
    mkdirSync(join(dir, "node_modules"));
    const empty = run(dir, [bin("check-licenses")]);
    expect(empty.code).toBe(1);
    expect(empty.out).toContain("run bun install");
    const bare = repo({ "package.json": JSON.stringify({ name: "fx" }) });
    expect(run(bare, [bin("check-licenses")]).code).toBe(1);
  });

  describe("a lock entry Bun skips", () => {
    let dir: string;
    let lock: string;
    let pinned: string;
    beforeAll(() => {
      // Tailwind's oxide-wasm32-wasi shape: "a" bundles its own "b", and the top-level "b" serves
      // only "c", which this platform leaves out.
      const mit = { version: "1.0.0", license: "MIT" };
      dir = repo({
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
      for (const name of ["a", "b", "c"])
        prepareCommand(join(dir, "src", name), [
          process.execPath,
          "pm",
          "pack",
          "--destination",
          dir,
        ]);
      prepareCommand(dir, [process.execPath, "install"]);
      lock = join(dir, "bun.lock");
      pinned = readFileSync(lock, "utf8").replace(
        /("c": \["c@[^"]*", \{ "dependencies": \{ "b": "1\.0\.0" \})/,
        '$1, "os": "none"',
      );
      if (!pinned.includes('"os": "none"'))
        throw new Error(`Could not mark the optional dependency as skipped in ${lock}:\n${pinned}`);
      writeFileSync(lock, pinned);
      rmSync(join(dir, "node_modules"), { recursive: true });
      prepareCommand(dir, [process.execPath, "install", "--frozen-lockfile"]);
    });
    test("passes when no installed package needs the skipped entry", () => {
      expect(existsSync(join(dir, "node_modules/b"))).toBe(false);
      expect(run(dir, [bin("check-licenses")])).toEqual({ code: 0, out: "" });
    });
    test("ignores prototype object properties when resolving a peer", () => {
      const lockWithPeer = pinned.replace(
        '"name": "fx",',
        `"name": "fx", "peerDependencies": { "constructor": "*" },`,
      );
      expect(lockWithPeer).not.toBe(pinned);
      writeFileSync(lock, lockWithPeer);
      try {
        expect(run(dir, [bin("check-licenses")])).toEqual({ code: 0, out: "" });
      } finally {
        writeFileSync(lock, pinned);
      }
    });
    test("reports a needed dependency missing from its bundle", () => {
      const bundle = join(dir, "node_modules/a/node_modules/b");
      renameSync(bundle, `${bundle}-away`);
      try {
        const unbundled = run(dir, [bin("check-licenses")]);
        expect(unbundled.code).toBe(1);
        expect(unbundled.out).toContain("a/b");
      } finally {
        renameSync(`${bundle}-away`, bundle);
      }
    });
  });

  test("check-staged runs it when bun.lock or package.json is staged", () => {
    const dir = installed(
      { planted: license("GPL-3.0-only") },
      { private: true, allow: [{ check: "coupling", path: "package.json", reason: "fixture" }] },
    );
    write(dir, { "notes.txt": "x\n" });
    sh(dir, ["add", "notes.txt"]);
    expect(run(dir, [bin("check-staged")]).out).not.toContain("[check-licenses]");
    write(dir, { "package.json": readFileSync(join(dir, "package.json"), "utf8") + "\n" });
    sh(dir, ["add", "package.json"]);
    const r = run(dir, [bin("check-staged")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("[check-licenses] planted");
  });
});

const chromeTestPlatform =
  process.platform === "darwin" ? (process.arch === "arm64" ? "mac_arm" : "mac") : "linux";
const chromeTestExecutable =
  process.platform === "darwin"
    ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    : "chrome";

describe("chrome", () => {
  const noInstaller = (_tools: string) => {};
  const fakeInstaller = (tools: string, script: string) =>
    writeFileSync(join(tools, "bunx"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  test.each([
    ["cannot start", noInstaller, []],
    ["is killed", (tools: string) => fakeInstaller(tools, 'kill -TERM "$$"'), ["/bin", "/usr/bin"]],
    [
      "exceeds its output buffer",
      (tools: string) => fakeInstaller(tools, "head -c 4194304 /dev/zero"),
      ["/bin", "/usr/bin"],
    ],
  ] as const)("Chrome returns undefined when the installer %s", async (_, arrange, systemPath) => {
    const { chromeBinary, chromeBinaryAsync } = await import("../lib/chrome.ts");
    const dir = temp();
    const cache = join(dir, "cache");
    const tools = join(dir, "bin");
    mkdirSync(tools);
    arrange(tools);
    const cwd = process.cwd();
    const saved = { ...process.env };
    process.chdir(dir);
    process.env.PATH = [tools, ...systemPath].join(delimiter);
    process.env.PUPPETEER_CACHE_DIR = cache;
    delete process.env.CHROME_BINARY;
    try {
      expect(chromeBinary()).toBeUndefined();
      expect(await chromeBinaryAsync()).toBeUndefined();
      expect(readdirSync(cache)).toEqual([]);
    } finally {
      process.chdir(cwd);
      process.env = saved;
    }
  });

  test.each([
    ["sync", "chromeBinary"],
    ["async", "chromeBinaryAsync"],
  ] as const)(
    "Chrome leaves a competing unpack alone when it starts after cache lookup (%s)",
    async (kind, method) => {
      const chromeModule = await import("../lib/chrome.ts");
      const dir = temp();
      const build = `${chromeTestPlatform}-11.0.1`;
      const tools = join(dir, "bin");
      mkdirSync(tools);
      writeFileSync(
        join(tools, "bunx"),
        `#!/bin/sh
while [ "$1" != --path ]; do shift; done
mkdir -p "$2/chrome/${build}/chrome-x" "$PUPPETEER_CACHE_DIR/chrome/${build}"
: > "$PUPPETEER_CACHE_DIR/chrome/11.0.1-chrome-x.zip"
: > "$PUPPETEER_CACHE_DIR/chrome/${build}/unpacking"
: > "$2/chrome/${build}/chrome-x/chrome"
printf '%s\\n' "$2/chrome/${build}/chrome-x/chrome"
`,
        { mode: 0o755 },
      );
      const cwd = process.cwd();
      const saved = { ...process.env };
      process.chdir(dir);
      process.env.PATH = [tools, "/bin", "/usr/bin"].join(delimiter);
      delete process.env.CHROME_BINARY;
      try {
        const cache = join(dir, kind);
        process.env.PUPPETEER_CACHE_DIR = cache;
        expect(await chromeModule[method]()).toBeUndefined();
        expect(readdirSync(cache)).toEqual(["chrome"]);
        expect(readdirSync(join(cache, "chrome", build))).toEqual(["unpacking"]);
        expect(existsSync(join(cache, "chrome", "11.0.1-chrome-x.zip"))).toBe(true);
      } finally {
        process.chdir(cwd);
        process.env = saved;
      }
    },
  );

  test.each([
    {
      stage: "placement",
      arrange: (_cache: string, _build: string) => {},
      stageCount: 0,
      script: 'printf "%s\\n" "$2/chrome/build/chrome-x/chrome"\n',
      error: /ENOENT/,
    },
    {
      stage: "retirement",
      arrange: (cache: string, build: string) =>
        mkdirSync(join(cache, "chrome", build), { recursive: true }),
      stageCount: 0,
      script:
        'mkdir -p "$2/died"\n: > "$2/died/occupied"\nprintf "%s\\n" "$2/chrome/%BUILD%/chrome-x/chrome"\n',
      error: /ENOTEMPTY|EEXIST/,
    },
    {
      stage: "cleanup",
      arrange: (_cache: string, _build: string) => {},
      stageCount: 2,
      script: ': > "$2/occupied"\nchmod a-w "$2"\n',
      error: /EACCES|EPERM|ENOTEMPTY/,
    },
  ] as const)(
    "Chrome $stage propagates unexpected install errors",
    async ({ arrange, stageCount, script, error }) => {
      const { chromeBinary, chromeBinaryAsync } = await import("../lib/chrome.ts");
      const dir = temp();
      const chromeCache = join(dir, "cache");
      const build = `${chromeTestPlatform}-1.2.3`;
      mkdirSync(join(dir, "bin"));
      writeFileSync(
        join(dir, "bin/bunx"),
        `#!/bin/sh\nwhile [ "$1" != --path ]; do shift; done\n${script.replace("%BUILD%", build)}`,
        { mode: 0o755 },
      );
      arrange(chromeCache, build);
      const cwd = process.cwd();
      const saved = { ...process.env };
      process.chdir(dir);
      process.env.PATH = [join(dir, "bin"), "/bin", "/usr/bin"].join(delimiter);
      process.env.PUPPETEER_CACHE_DIR = chromeCache;
      delete process.env.CHROME_BINARY;
      const stages = () => readdirSync(chromeCache).filter((name) => name.startsWith(".install-"));
      try {
        expect(() => chromeBinary()).toThrow(error);
        expect(await rejection(chromeBinaryAsync())).toMatch(error);
        expect(stages()).toHaveLength(stageCount);
      } finally {
        for (const name of stages()) chmodSync(join(chromeCache, name), 0o700);
        process.chdir(cwd);
        process.env = saved;
      }
    },
  );

  const plant = (path: string) => {
    write("/", { [path]: "" });
    return path;
  };
  const withChromeCache = (cache: string, check: () => void) => {
    const saved = { ...process.env };
    const cwd = process.cwd();
    process.env.PUPPETEER_CACHE_DIR = cache;
    delete process.env.CHROME_BINARY;
    try {
      check();
    } finally {
      process.chdir(cwd);
      process.env = saved;
    }
  };

  test("Chrome selects the newest cached executable for this platform and kind", async () => {
    const { cachedChrome } = await import("../lib/chrome.ts");
    const cache = temp();
    plant(join(cache, "chrome", `${chromeTestPlatform}-9.0.1`, "chrome-x", chromeTestExecutable));
    const newest = plant(
      join(cache, "chrome", `${chromeTestPlatform}-10.0.1`, "chrome-x", chromeTestExecutable),
    );
    plant(join(cache, "chrome", "other-99.0.0", "chrome-x", chromeTestExecutable));
    const shell = plant(
      join(
        cache,
        "chrome-headless-shell",
        `${chromeTestPlatform}-10.0.1`,
        "chrome-headless-shell-x",
        "chrome-headless-shell",
      ),
    );
    withChromeCache(cache, () => {
      expect(cachedChrome()).toBe(newest);
      expect(cachedChrome({ shell: true })).toBe(shell);
    });
  });

  test("Chrome selects a newer cached build only after its unpack ends", async () => {
    const { cachedChrome } = await import("../lib/chrome.ts");
    const cache = temp();
    const earlier = plant(
      join(cache, "chrome", `${chromeTestPlatform}-10.0.1`, "chrome-x", chromeTestExecutable),
    );
    const unpacking = plant(
      join(cache, "chrome", `${chromeTestPlatform}-11.0.1`, "chrome-x", chromeTestExecutable),
    );
    // The archive stays beside the build until the unpack ends, even after the executable appears.
    write(cache, { "chrome/11.0.1-chrome-x.zip": "" });
    withChromeCache(cache, () => {
      expect(cachedChrome()).toBe(earlier);
      rmSync(join(cache, "chrome/11.0.1-chrome-x.zip"));
      expect(cachedChrome()).toBe(unpacking);
    });
  });

  test("Chrome takes the consumer's puppeteer-core pin for the requested executable kind", async () => {
    const { cachedChrome } = await import("../lib/chrome.ts");
    const cache = temp();
    const pinned = plant(
      join(cache, "chrome", `${chromeTestPlatform}-9.0.1`, "chrome-x", chromeTestExecutable),
    );
    plant(join(cache, "chrome", `${chromeTestPlatform}-10.0.1`, "chrome-x", chromeTestExecutable));
    plant(
      join(
        cache,
        "chrome-headless-shell",
        `${chromeTestPlatform}-10.0.1`,
        "chrome-headless-shell-x",
        "chrome-headless-shell",
      ),
    );
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
    withChromeCache(cache, () => {
      process.chdir(consumer);
      expect(cachedChrome()).toBe(pinned);
      expect(cachedChrome({ shell: true })).toBeUndefined();
    });
  });

  test("Chrome honours CHROME_BINARY ahead of an available cached build", async () => {
    const { chromeBinary } = await import("../lib/chrome.ts");
    const cache = temp();
    plant(join(cache, "chrome", `${chromeTestPlatform}-10.0.1`, "chrome-x", chromeTestExecutable));
    withChromeCache(cache, () => {
      process.env.CHROME_BINARY = "/opt/own-chrome";
      expect(chromeBinary()).toBe("/opt/own-chrome");
    });
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
  test.each([
    [
      "asynchronous",
      "chromeBinaryAsync",
      (archive: string) => setTimeout(() => rmSync(archive), 1_500),
    ],
    [
      "blocking",
      "chromeBinary",
      (archive: string) => Bun.spawn(["sh", "-c", `sleep 1.5; rm "${archive}"`]),
    ],
  ] as const)(
    "the %s Chrome lookup waits for another job's unpack instead of installing over it",
    async (_, method, finishUnpack) => {
      const chromeModule = await import("../lib/chrome.ts");
      const dir = temp();
      const cache = join(dir, "cache");
      const chrome = join(
        cache,
        "chrome",
        `${chromeTestPlatform}-11.0.1`,
        "chrome-x",
        chromeTestExecutable,
      );
      const archive = join(cache, "chrome", "11.0.1-chrome-x.zip");
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
        finishUnpack(archive);
        expect(await chromeModule[method]()).toBe(chrome);
        expect(existsSync(archive)).toBe(false);
        expect(existsSync(log)).toBe(false);
      } finally {
        process.chdir(cwd);
        process.env = saved;
      }
    },
    limit(30_000),
  );

  // An install that died left its archive beside a half-unpacked build.
  const oldArchive = (cache: string) => {
    const archive = join(cache, "chrome", "11.0.1-chrome-x.zip");
    write(cache, { "chrome/11.0.1-chrome-x.zip": "" });
    const old = new Date(Date.now() - 600_000);
    utimesSync(archive, old, old);
  };
  describe.each([
    [
      "a half-unpacked build",
      (cache: string, rel: string) => {
        write(cache, { [rel]: "half" });
        oldArchive(cache);
      },
    ],
    ["an archive without a build", oldArchive],
    [
      "a build folder without an executable or an archive",
      (cache: string, rel: string) => write(cache, { [join(dirname(rel), "partial")]: "" }),
    ],
  ] as const)("Chrome replaces %s after an install died", (_, arrange) => {
    let cache: string;
    let installed: string | undefined;
    let cachedBefore: string | undefined;
    let cachedAfter: string | undefined;
    let elapsed: number;
    const rel = join("chrome", `${chromeTestPlatform}-11.0.1`, "chrome-x", chromeTestExecutable);
    beforeAll(async () => {
      const { cachedChrome, chromeBinary } = await import("../lib/chrome.ts");
      const dir = temp();
      cache = join(dir, "cache");
      arrange(cache, rel);
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
        cachedBefore = cachedChrome({ anyBuild: true });
        const started = Date.now();
        installed = chromeBinary();
        elapsed = Date.now() - started;
        cachedAfter = cachedChrome({ anyBuild: true });
      } finally {
        process.env = saved;
      }
    }, limit(30_000));

    test("returns and caches the replacement executable within five seconds", () => {
      expect(cachedBefore).toBeUndefined();
      expect(elapsed).toBeLessThan(5_000);
      expect(installed).toBe(join(cache, rel));
      expect(cachedAfter).toBe(join(cache, rel));
    });

    test("installs the whole executable and clears interrupted install files", () => {
      expect(readFileSync(join(cache, rel), "utf-8")).toBe("whole");
      expect(existsSync(join(cache, "chrome/11.0.1-chrome-x.zip"))).toBe(false);
      expect(readdirSync(cache)).not.toContainEqual(matchingText(/^\.install-/));
    });
  });
});

/** Observe complete protocol lines while the subprocess keeps its output open. */
function protocolLines(stdout: ReadableStream<Uint8Array>) {
  let output = "";
  let ended = false;
  const decoder = new TextDecoder();
  const drained = (async () => {
    for await (const chunk of stdout) output += decoder.decode(chunk, { stream: true });
    output += decoder.decode();
    ended = true;
  })();
  const response = async (id: number, method: string, timeoutMs: number) => {
    const marker = `"id":${id}`;
    const completeLine = () =>
      output
        .split("\n")
        .slice(0, -1)
        .find((line) => line.includes(marker));
    await until(() => ended || completeLine() !== undefined, `the answer to ${method}`, {
      timeoutMs,
      intervalMs: 100,
    });
    const line = completeLine();
    if (line === undefined) throw new Error(`no answer to ${method}`);
    return line;
  };
  return { response, drained };
}

test("the protocol reader rejects a reply with no terminating newline", async () => {
  const partial = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{}}'));
      controller.close();
    },
  });
  const protocol = protocolLines(partial);
  expect(await rejection(protocol.response(1, "initialize", 1_000))).toContain(
    "no answer to initialize",
  );
  await protocol.drained;
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
      const output = protocolLines(server.stdout);
      const call = async (id: number, method: string, params: object) => {
        await server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        return jsonObject(await output.response(id, method, 60_000)).result;
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
        await output.drained;
      }
    },
    limit(120_000),
  );

  test(
    "starts on any cached build where the pinned one is missing, without a download",
    async () => {
      const cache = temp();
      write("/", {
        [join(cache, "chrome", `${chromeTestPlatform}-10.0.1`, "chrome-x", chromeTestExecutable)]:
          "",
      });
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
      const output = protocolLines(server.stdout);
      try {
        await server.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })}\n`,
        );
        expect(await output.response(1, "initialize", 30_000)).toContain("chrome_devtools");
        expect(existsSync(log)).toBe(false);
      } finally {
        server.kill("SIGTERM");
        await server.exited;
        await output.drained;
      }
    },
    limit(60_000),
  );
});

function processExists(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

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

  test.each([
    ["stop()", "s.stop();", (_pid: number): void => undefined],
    [
      "SIGKILL to the process that served",
      "await new Promise(() => {});",
      (pid: number): void => {
        process.kill(pid, "SIGKILL");
      },
    ],
  ] as const)(
    "%s ends a server behind a wrapper",
    async (_, childAction, parentAction) => {
      const app = join(temp(), "app.ts");
      const marker = join(dirname(app), "server.pid");
      writeFileSync(
        app,
        "Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => new Response(String(process.pid)) });\n",
      );
      // The shell stays as the parent, so the server is a grandchild.
      const wrapped = JSON.stringify(["sh", "-c", `${process.execPath} ${app}; :`]);
      const parent = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const s = await (await import(${JSON.stringify(join(import.meta.dirname, "..", "lib", "serve.ts"))})).serve(${wrapped}); const pid = await (await fetch(s.url)).text(); await Bun.write(${JSON.stringify(marker)}, pid + "\\n"); ${childAction}`,
        ],
        { stdout: "ignore" },
      );
      try {
        await until(
          () => fileReady(marker, (value) => /^\d+\n$/.test(value)),
          `the wrapped server's PID at ${marker}`,
        );
        const pid = Number(readFileSync(marker, "utf8"));
        expect(pid).toBeGreaterThan(0);
        try {
          parentAction(parent.pid);
          await until(() => !processExists(pid), "the wrapped server to exit", {
            timeoutMs: 5_000,
            intervalMs: 100,
          });
          expect(processExists(pid)).toBe(false);
        } finally {
          spawnSync("kill", ["-TERM", String(pid)], { stdio: "ignore" });
        }
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
  run(dir, [bin("scaffolding"), "shell"], env);

test("shell input discovery uses the index shebang and ignores grep.patternType", () => {
  const dir = repo({
    "with space": "#!/usr/bin/env -S bash\ntrue\n",
    "tool.py": "#!/bin/sh\ntrue\n",
    later: "text\n#!/bin/sh\n",
    plain: "text\n",
  });
  prepareGit(dir, ["config", "grep.patternType", "fixed"]);
  write(dir, { "with space": "#!/usr/bin/env python\n" });
  expect(gitShellShebangs(dir, ["with space", "later", "plain"])).toEqual(["with space"]);
  expect(gitShellShebangs(dir, ["with space", "later"], "HEAD")).toEqual(["with space"]);
});

test.each([
  ["with space", { "with space": "#!/usr/bin/env python\n" }, false],
  ["tool.py", { "tool.py": "#!/bin/sh\ntrue\n" }, false],
  ["a.bash", {}, true],
])("disk shell input classifies %s", (name, inputs, shell) => {
  const dir = temp();
  write(dir, inputs as Record<string, string>);
  expect(shellInput(name, join(dir, name))).toBe(shell);
});

test("tracked inputs exclude symlinks, dependencies and unmerged index entries", () => {
  const dir = repo({
    "keep.sh": "#!/bin/sh\n",
    "missing.sh": "#!/bin/sh\n",
    "conflict.sh": "#!/bin/sh\n",
  });
  symlinkSync("keep.sh", join(dir, "linked.sh"));
  write(dir, { "node_modules/dependency.sh": "#!/bin/sh\n" });
  prepareGit(dir, ["add", "-f", "--", "linked.sh", "node_modules/dependency.sh"]);
  const hash = sh(dir, ["rev-parse", ":conflict.sh"]).stdout.toString().trim();
  const conflict = `0 ${"0".repeat(hash.length)}\tconflict.sh\n100644 ${hash} 1\tconflict.sh\n`;
  prepareGit(dir, ["update-index", "--index-info"], conflict);
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
  test("fails on a style finding in a tracked script", async () => {
    const dir = repo({ "main.sh": shellStyleFinding });
    const red = checkedShell(dir, await realShellcheckFixture(dir));
    expect(red.code, red.out).toBe(1);
    expect(red.out).toContain("In main.sh");
    expect(red.out).toContain("SC2006 (style)");
  });

  test("follows an untracked source without printing its contents", async () => {
    const dir = repo({
      "main.sh": '#!/bin/sh\n. ./local-config\nprintf "%s\\n" "$value"\n',
    });
    const assignment = "PRIVATE_KEY=synthetic-shellcheck-fixture";
    write(dir, { "local-config": `${shellStyleFinding}${assignment}\nvalue=from_source\n` });
    const result = checkedShell(dir, await realShellcheckFixture(dir));
    expect(result.out).not.toContain(assignment);
    expect(result.out).not.toContain("SC2006");
    expect(result.code).toBe(0);
  });

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
    expect(Array.from(red.out.matchAll(/In .* line 2/g), ([header]) => header).sort()).toEqual([
      "In with env line 2",
      "In with space.sh line 2",
    ]);
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
      matchingText(
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

describe.each([".githooks/pre-push", "template/.githooks/pre-push"])("%s", (path) => {
  let dir: string, fake: string;
  beforeAll(() => {
    dir = repo({});
    fake = join(dir, "node_modules", ".bin");
    mkdirSync(fake, { recursive: true });
    writeFileSync(
      join(fake, "bun"),
      '#!/bin/sh\nif [ "$3" = check-confidential ]; then cat > refs.log; exit; fi\nprintf "%s\\n" "${GIT_DIR-unset}" "${GIT_INDEX_FILE-unset}" "$@"\n',
      { mode: 0o755 },
    );
  });
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
  test("clears Git-local variables and passes each branch range to the gate", () => {
    const refs = "refs/heads/a a1 refs/heads/a a0\nHEAD@{1 day ago} b1 refs/heads/b b0\n";
    const r = push(refs);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "refs.log"), "utf8")).toBe(refs);
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
  });
  test.each([
    ["no refs", ""],
    ["only a tag", "refs/tags/v1 a1 refs/tags/v1 a0\n"],
    ["only a deletion", "(delete) 0000 refs/heads/a a0\n"],
  ])("skips the branch gate for %s", (_, refs) => {
    const empty = push(refs);
    expect(empty.status).toBe(0);
    expect(empty.stdout).toBe("");
  });
});

describe("scaffolding markdown", () => {
  const check = (dir: string, ...args: string[]) =>
    run(dir, [bin("scaffolding"), "markdown", ...args]);
  const bad = "Body without a title.\n";
  const content = "Body with <span>inline HTML</span>.\n";
  const headings = "# Same\n\n_Intro_\n\n# Same\n";
  const manifest = (folders: unknown) =>
    JSON.stringify({
      scaffolding: { markdown: { content: folders } },
      scripts: { eslint: "true", prettier: "true" },
    });

  test("uses the content rules in each named folder and its descendants", () => {
    const dir = repo({
      "package.json": manifest(["./articles/", "records"]),
      "articles/nested/post.md": content,
      "records/item.md": headings,
    });
    const result = check(dir);
    expect(result.code, result.out).toBe(0);
  });

  test("reports inline HTML and a missing first heading outside the named folders", () => {
    const dir = repo({
      "package.json": manifest(["articles"]),
      "articles/post.md": content,
      "articles-old/post.md": content,
      "docs/headings.md": headings,
    });
    const result = check(dir);
    expect(result.code).toBe(1);
    expect(result.out.trim().split("\n")).toEqual([
      matchingText(/^articles-old\/post\.md:1.*error MD033\b/),
      matchingText(/^articles-old\/post\.md:1.*error MD041\b/),
      matchingText(/^docs\/headings\.md:3.*error MD036\b/),
      matchingText(/^docs\/headings\.md:5.*error MD024\b/),
      matchingText(/^docs\/headings\.md:5.*error MD025\b/),
      markdownRepair,
    ]);
  });

  test("still reports layout findings in content, even with an inline disable", () => {
    const dir = repo({
      "package.json": manifest(["articles"]),
      "articles/post.md": "<!-- markdownlint-disable MD032 -->\n\n" + content + "- Item\n",
    });
    const result = check(dir);
    expect(result.code).toBe(1);
    expect(result.out.trim().split("\n")).toEqual([
      matchingText(/^articles\/post\.md:4 error MD032\b/),
      markdownRepair,
    ]);
  });

  test.each([
    ["a non-array", "articles", "must be an array"],
    ["null", null, "must be an array"],
    ["a non-string entry", [42], "must be a folder path string"],
    ["an absolute path", ["/articles"], "must be repository-relative"],
    ["a Windows absolute path", ["C:\\articles"], "must be repository-relative"],
    ["a path outside the repository", ["../articles"], "leaves the repository"],
    ["the repository root", ["."], "must name a folder below the repository root"],
    [
      "the repository root with a trailing slash",
      ["./"],
      "must name a folder below the repository root",
    ],
    ["a missing folder", ["missing"], "must name an existing folder"],
    ["a regular file", ["package.json"], "must name an existing folder"],
  ])("rejects %s in the content configuration even with no Markdown files", (_, folders, error) => {
    const result = check(repo({ "package.json": manifest(folders) }));
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^\[markdown\] scaffolding\.markdown\.content/);
    expect(result.out).toContain(error);
  });

  test("rejects a content folder symlink that points outside the repository", () => {
    const dir = repo({ "package.json": manifest(["articles"]) });
    symlinkSync(temp(), join(dir, "articles"));
    const result = check(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      'scaffolding.markdown.content[0] ("articles") leaves the repository',
    );
  });

  test.each([["markdown", "--fix"], ["fix"]])(
    "%s uses the content rules when fixing Markdown",
    (...args) => {
      const trailingSpace = content.trimEnd() + " \n";
      const dir = repo({
        "package.json": manifest(["articles"]),
        "articles/post.md": trailingSpace,
        "docs/post.md": trailingSpace,
      });
      const result = run(dir, [bin("scaffolding"), ...args]);
      expect(result.code).toBe(1);
      expect(result.out).toContain("docs/post.md:1 error MD041");
      expect(result.out).not.toContain("articles/post.md");
      expect(readFileSync(join(dir, "articles/post.md"), "utf8")).toBe(content);
      expect(readFileSync(join(dir, "docs/post.md"), "utf8")).toBe(content);
    },
  );

  test("uses the staged content folders for the pre-commit Markdown step", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        scaffolding: {
          markdown: { content: ["articles"] },
          private: true,
          skip: { format: "fixture", lint: "fixture" },
        },
      }),
      "articles/post.md": "# Post\n",
    });
    write(dir, { "articles/post.md": content });
    prepareGit(dir, ["add", "--", "articles/post.md"]);
    write(dir, { "package.json": manifest([]) });
    expect(run(dir, [bin("check-staged")]).code).toBe(0);
  });

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
      matchingText(/^double\.md:7 error MD025\b/),
      matchingText(/^nested\.md:7 error MD041\b/),
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
    prepareGit(dir, ["add", "-f", "--", "linked.md", "node_modules/tracked-dependency.md"]);
    prepareGit(dir, ["update-index", "--add", "--cacheinfo", `160000,${tip},sub`]);
    const r = check(dir);
    expect(r.code).toBe(1);
    expect(r.out.trim().split("\n")).toEqual([
      containingText("[tracked].md:1 error MD041"),
      containingText("src/inline.md:3 error MD041"),
      markdownRepair,
    ]);
  });

  describe("trailing spaces beside an unfixable title", () => {
    const text = "Body without a title. \n";
    let dir: string;
    beforeAll(() => {
      dir = repo({ "tracked.md": text, "clean.md": "# Clean\n" });
      write(dir, { "untracked.md": text });
    });
    afterEach(() => write(dir, { "tracked.md": text, "untracked.md": text }));

    test("reports both findings and keeps tracked bytes in check mode", () => {
      const result = check(dir);
      expect(result.code).toBe(1);
      expect(new Set(result.out.match(/MD(?:009|041)/g))).toEqual(new Set(["MD009", "MD041"]));
      expect(readFileSync(join(dir, "tracked.md"), "utf8")).toBe(text);
    });

    test("fixes trailing spaces without changing untracked content or hiding the title", () => {
      const result = check(dir, "--fix");
      expect(result.code).toBe(1);
      expect(new Set(result.out.match(/MD(?:009|041)/g))).toEqual(new Set(["MD041"]));
      expect(sh(dir, ["diff", "--name-only"]).stdout.toString()).toBe("tracked.md\n");
      expect(readFileSync(join(dir, "tracked.md"), "utf8")).toBe(bad);
      expect(readFileSync(join(dir, "untracked.md"), "utf8")).toBe(text);
    });
  });
});
