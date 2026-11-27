import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, test } from "vitest";
import {
  classifyPrettierStdin,
  collectChildOutput,
  ConcurrencyPool,
  failPartialPrettierResult,
  findDifferingScript,
  hasNoPrettierParser,
  parseEslintRuleMetadata,
  passPartialPrettierResult,
  resolvePartialToolResult,
  spawnStagedEslint,
  spawnStagedProcess,
  spawnStagedWithEnv,
  type ToolRun,
} from "../lib/staged-runner.ts";

test("ConcurrencyPool bounds parallel execution to the configured limit", async () => {
  const pool = new ConcurrencyPool(2);
  let active = 0;
  let peak = 0;
  const runTask = () =>
    pool.run(async () => {
      peak = Math.max(peak, ++active);
      await Bun.sleep(25);
      active--;
      return "ok";
    });
  const results = await Promise.all([runTask(), runTask(), runTask(), runTask()]);
  expect(results).toEqual(["ok", "ok", "ok", "ok"]);
  expect(peak).toBe(2);
});

test.each([
  {
    label: "leaves run untouched when metadata is empty",
    metadata: Buffer.alloc(0),
    run: { out: "ok", code: 0, stdout: Buffer.from("ok") },
    expected: { out: "ok", code: 0, stdout: Buffer.from("ok") },
  },
  {
    label: "attaches parsed rule IDs from valid JSON",
    metadata: Buffer.from('{"rules":["no-var","eqeqeq"]}'),
    run: { out: "", code: 1, stdout: Buffer.alloc(0) },
    expected: { out: "", code: 1, stdout: Buffer.alloc(0), rules: ["no-var", "eqeqeq"] },
  },
  {
    label: "fails when rules field is not a string array",
    metadata: Buffer.from('{"rules":[123]}'),
    run: { out: "warn\n", code: 0, stdout: Buffer.alloc(0) },
    expected: {
      out: "warn\n[check:staged] eslint: could not read formatter rule IDs (invalid rule IDs), so the hook cannot show the rule guides. Run bun install and retry the commit, then report persistent failures with this diagnostic.\n",
      code: 1,
      stdout: Buffer.alloc(0),
    },
  },
])("parseEslintRuleMetadata $label", ({ metadata, run, expected }) => {
  expect(parseEslintRuleMetadata(metadata, run)).toEqual(expected);
});

test("collectChildOutput buffers stdout, stderr, and reports non-zero exit codes", async () => {
  const child = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("out:"); process.stderr.write("err"); process.exit(3);'],
    { stdio: ["pipe", "pipe", "pipe"] },
  ) as ChildProcessWithoutNullStreams;
  const result = await collectChildOutput(child);
  expect(result.code).toBe(3);
  expect(result.out).toBe("out:err");
  expect(result.stdout.toString()).toBe("out:");
});

test("spawnStagedProcess passes stdin and captures stdout", async () => {
  const run = await spawnStagedProcess(
    process.execPath,
    ["-e", "const text = await Bun.stdin.text(); process.stdout.write(text.toUpperCase());"],
    Buffer.from("hello"),
  );
  expect(run.code).toBe(0);
  expect(run.stdout.toString()).toBe("HELLO");
});

test("spawnStagedProcess explains how to fix an executable that cannot start", async () => {
  const run = await spawnStagedProcess("/nonexistent-staged-check-executable", []);
  expect(run.code).toBe(1);
  expect(run.out).toMatch(
    /^\[check:staged\] Could not start \/nonexistent-staged-check-executable \(.*\)\. Check the executable path and permissions, then retry the commit\.\n$/,
  );
});

test("spawnStagedWithEnv forwards extra environment variables", async () => {
  const run = await spawnStagedWithEnv(
    process.execPath,
    ["-e", 'process.stdout.write(process.env.STAGED_TEST_VAR ?? "");'],
    { STAGED_TEST_VAR: "present" },
  );
  expect(run.code).toBe(0);
  expect(run.stdout.toString()).toBe("present");
});

test("spawnStagedEslint sets SCAFFOLDING_STAGED_ESLINT and reads fd 3 metadata", async () => {
  const script = [
    'import { writeFileSync } from "node:fs";',
    'process.stdout.write(process.env.SCAFFOLDING_STAGED_ESLINT ?? "");',
    'writeFileSync(3, JSON.stringify({ rules: ["demo/rule"] }));',
  ].join("\n");
  const run = await spawnStagedEslint("-e", [script]);
  expect(run.code).toBe(0);
  expect(run.stdout.toString()).toBe("1");
  expect(run.rules).toEqual(["demo/rule"]);
});

test("spawnStagedEslint reads fd 3 metadata written after the child exits", async () => {
  const script = [
    'import { spawn } from "node:child_process";',
    `spawn("sh", ["-c", 'sleep 0.2; printf "%s" "$1" >&3', "sh", '{"rules":["demo/late-rule"]}'], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", 3],
    }).unref();`,
  ].join("\n");
  const run = await spawnStagedEslint("-e", [script]);
  expect(run.code).toBe(0);
  expect(run.rules).toEqual(["demo/late-rule"]);
});

test.each<{ label: string; input: string; run: ToolRun; expected: string }>([
  {
    label: "fails when prettier exited non-zero",
    input: "a\n",
    run: { out: "err", code: 2, stdout: Buffer.from("a\n") },
    expected: "fail",
  },
  {
    label: "passes when formatted output matches input",
    input: "a\n",
    run: { out: "a\n", code: 0, stdout: Buffer.from("a\n") },
    expected: "pass",
  },
  {
    label: "fails when formatted output differs",
    input: "a",
    run: { out: "a\n", code: 0, stdout: Buffer.from("a\n") },
    expected: "fail",
  },
  {
    label: "passes when output is empty and input has non-whitespace",
    input: "unknown content",
    run: { out: "", code: 0, stdout: Buffer.alloc(0) },
    expected: "pass",
  },
  {
    label: "asks for parser check when output is empty and input is whitespace-only",
    input: "   \n",
    run: { out: "", code: 0, stdout: Buffer.alloc(0) },
    expected: "check-parser",
  },
])("classifyPrettierStdin: $label", ({ input, run, expected }) => {
  expect(classifyPrettierStdin(Buffer.from(input), run)).toBe(expected);
});

test.each([
  { info: { out: "", code: 0, stdout: Buffer.from('{"inferredParser":null}') }, expected: true },
  {
    info: { out: "", code: 0, stdout: Buffer.from('{"inferredParser":"typescript"}') },
    expected: false,
  },
  {
    info: { out: "err", code: 1, stdout: Buffer.from('{"inferredParser":null}') },
    expected: false,
  },
])("hasNoPrettierParser returns $expected", ({ info, expected }) => {
  expect(hasNoPrettierParser(info)).toBe(expected);
});

test.each<{
  label: string;
  staged: Record<string, string> | undefined;
  working: Record<string, string> | undefined;
  expected: string | undefined;
}>([
  {
    label: "matches identical script maps",
    staged: { a: "1" },
    working: { a: "1" },
    expected: undefined,
  },
  { label: "detects modified script", staged: { a: "1" }, working: { a: "2" }, expected: "a" },
  {
    label: "detects added script in working tree",
    staged: { a: "1" },
    working: { a: "1", b: "2" },
    expected: "b",
  },
])("findDifferingScript: $label", ({ staged, working, expected }) => {
  expect(findDifferingScript(staged, working)).toBe(expected);
});

test("passPartialPrettierResult clears output and sets exit code 0", () => {
  expect(
    passPartialPrettierResult({ out: "formatted\n", code: 0, stdout: Buffer.from("formatted\n") }),
  ).toEqual({ out: "", code: 0, stdout: Buffer.from("formatted\n") });
});

test.each<{
  label: string;
  run: ToolRun;
  expected: ToolRun;
}>([
  {
    label: "reports not formatted and exit 1 when code is 0",
    run: { out: "diff\n", code: 0, stdout: Buffer.from("diff\n") },
    expected: {
      out: "[check:staged] prettier: a.ts as staged\nThe staged file differs from Prettier's output. Format the file with Prettier, stage the formatted edits, and retry the commit.\n",
      code: 1,
      stdout: Buffer.from("diff\n"),
    },
  },
  {
    label: "preserves stderr and non-zero exit code on syntax error",
    run: { out: "SyntaxError\n", code: 2, stdout: Buffer.alloc(0) },
    expected: {
      out: "[check:staged] prettier: a.ts as staged\nSyntaxError\n",
      code: 2,
      stdout: Buffer.alloc(0),
    },
  },
])("failPartialPrettierResult: $label", ({ run, expected }) => {
  expect(failPartialPrettierResult("a.ts", run)).toEqual(expected);
});

test.each<{
  label: string;
  tool: string;
  run: ToolRun;
  expected: ToolRun;
}>([
  {
    label: "clears output for clean eslint run",
    tool: "eslint",
    run: { out: "ignored\n", code: 0, stdout: Buffer.alloc(0) },
    expected: { out: "", code: 0, stdout: Buffer.alloc(0) },
  },
  {
    label: "keeps output when eslint reported rules with exit 0",
    tool: "eslint",
    run: { out: "warning\n", code: 0, stdout: Buffer.alloc(0), rules: ["no-var"] },
    expected: {
      out: "[check:staged] eslint: a.ts as staged\nwarning\n",
      code: 0,
      stdout: Buffer.alloc(0),
      rules: ["no-var"],
    },
  },
  {
    label: "prefixes header when tool exits non-zero",
    tool: "stylelint",
    run: { out: "bad css\n", code: 2, stdout: Buffer.alloc(0) },
    expected: {
      out: "[check:staged] stylelint: a.ts as staged\nbad css\n",
      code: 2,
      stdout: Buffer.alloc(0),
    },
  },
])("resolvePartialToolResult: $label", ({ tool, run, expected }) => {
  expect(resolvePartialToolResult(tool, "a.ts", run)).toEqual(expected);
});
