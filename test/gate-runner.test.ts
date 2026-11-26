import { expect, test, vi } from "vitest";
import {
  formatStepLine,
  GateStepRunner,
  reportStoppedStep,
  stepConcurrencyLimit,
} from "../lib/gate-runner.ts";

test.each([
  { result: { name: "lint", code: 0, ms: 1250 }, expected: "[scaffolding] ok   lint 1.3 s" },
  { result: { name: "test", code: 1, ms: 400 }, expected: "[scaffolding] FAIL test 0.4 s" },
])("formatStepLine formats $result.name", ({ result, expected }) => {
  expect(formatStepLine(result)).toBe(expected);
});

test.each([
  { load: 8, cores: 16, expected: Infinity },
  { load: 16, cores: 16, expected: Infinity },
  { load: 20, cores: 16, expected: 12 },
  { load: 200, cores: 16, expected: 2 },
])("stepConcurrencyLimit($load, $cores) is $expected", ({ load, cores, expected }) => {
  expect(stepConcurrencyLimit(load, cores)).toBe(expected);
});

test("reportStoppedStep flushes buffered output before printing the stopped line", () => {
  const writes: string[] = [];
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((line: string) => {
    writes.push(line);
  });
  try {
    reportStoppedStep("test", "partial\n", "SIGTERM");
    expect(writes).toEqual(["partial\n", "[scaffolding] stopped test by SIGTERM"]);
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
  }
});

test("GateStepRunner.runParallel runs steps and records failing exit code", async () => {
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const runner = new GateStepRunner(process.cwd(), process.env, 2);
    const ok = await runner.runParallel([
      ["pass", "true"],
      ["fail", "exit 2"],
    ]);
    expect(ok).toBe(false);
    expect(runner.results.map((r) => r.name).sort()).toEqual(["fail", "pass"]);
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
  }
});

test("GateStepRunner.runOrdered enforces after dependencies and runs slow steps after quick ones under load", async () => {
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const runner = new GateStepRunner(process.cwd(), process.env, 2);
    const ok = await runner.runOrdered(
      [
        ["first", "sleep 0.05"],
        ["second", "true"],
        ["slow", "true"],
      ],
      { second: "first" },
      new Set(["first", "second"]),
    );
    expect(ok).toBe(true);
    const names = runner.results.map((r) => r.name);
    expect(names.indexOf("first")).toBeLessThan(names.indexOf("second"));
    expect(names.indexOf("second")).toBeLessThan(names.indexOf("slow"));
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
  }
});
