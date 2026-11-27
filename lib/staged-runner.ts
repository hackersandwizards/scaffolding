import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { finished } from "node:stream/promises";
import { isStrings, jsonObject } from "./repo.ts";

export type ToolRun = { out: string; code: number; stdout: Buffer; rules?: string[] };

export class ConcurrencyPool {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.free = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.free === 0) await new Promise<void>((go) => this.waiting.push(go));
    else this.free--;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}

export function parseEslintRuleMetadata(metadata: Buffer, run: ToolRun): ToolRun {
  if (!metadata.length) return run;
  try {
    const { rules } = jsonObject(metadata);
    if (!isStrings(rules)) throw new Error("invalid rule IDs");
    return { ...run, rules };
  } catch (error) {
    return {
      ...run,
      out: `${run.out}[check:staged] eslint: could not read formatter rule IDs (${(error as Error).message}), so the hook cannot show the rule guides. Run bun install and retry the commit, then report persistent failures with this diagnostic.\n`,
      code: 1,
    };
  }
}

export function collectChildOutput(
  child: ChildProcessWithoutNullStreams,
  stdin?: Buffer,
): Promise<ToolRun> {
  return new Promise<ToolRun>((done) => {
    // A child that exits before reading stdin raises EPIPE: caught so it cannot crash the check, and
    // counted as a failure so an unread file never passes.
    let unread = false;
    child.stdin.on("error", () => (unread = true));
    child.stdin.end(stdin);
    let out = "";
    const stdout: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => stdout.push(data));
    child.stderr.on("data", (data) => (out += data));
    child.on("error", (error) =>
      done({
        out: `[check:staged] Could not start ${child.spawnfile} (${String(error)}). Check the executable path and permissions, then retry the commit.\n`,
        code: 1,
        stdout: Buffer.alloc(0),
      }),
    );
    child.on("close", (code) => {
      const output = Buffer.concat(stdout);
      done({
        out: `${output}${out}`,
        code: unread ? code || 1 : (code ?? 1),
        stdout: output,
      });
    });
  });
}

export function spawnStagedProcess(
  bin: string,
  args: readonly string[],
  stdin?: Buffer,
): Promise<ToolRun> {
  const child = spawn(bin, [...args], {
    stdio: ["pipe", "pipe", "pipe", "ignore"],
  }) as ChildProcessWithoutNullStreams;
  return collectChildOutput(child, stdin);
}

export function spawnStagedWithEnv(
  bin: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<ToolRun> {
  const child = spawn(bin, [...args], {
    stdio: ["pipe", "pipe", "pipe", "ignore"],
    env: { ...process.env, ...env },
  }) as ChildProcessWithoutNullStreams;
  return collectChildOutput(child);
}

export async function spawnStagedEslint(
  bin: string,
  args: readonly string[],
  stdin?: Buffer,
): Promise<ToolRun> {
  const child = spawn(process.execPath, ["--no-env-file", "--bun", bin, ...args], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, SCAFFOLDING_STAGED_ESLINT: "1" },
  }) as ChildProcessWithoutNullStreams;
  const metadata: Buffer[] = [];
  const metadataStream = child.stdio[3];
  metadataStream?.on("data", (data: Buffer) => metadata.push(data));
  const [run] = await Promise.all([
    collectChildOutput(child, stdin),
    metadataStream && finished(metadataStream, { writable: false, cleanup: true }),
  ]);
  return parseEslintRuleMetadata(Buffer.concat(metadata), run);
}

// Output equal to the input is formatted, a blank file included. Otherwise prettier prints nothing
// for a file it has no parser for, which passes, and also formats a whitespace-only file it can
// parse to nothing, which fails, so a whitespace-only one asks which it is.
export function classifyPrettierStdin(
  input: Buffer,
  run: ToolRun,
): "pass" | "fail" | "check-parser" {
  if (run.code) return "fail";
  if (run.stdout.equals(input)) return "pass";
  if (run.stdout.length) return "fail";
  return /\S/.test(`${input}`) ? "pass" : "check-parser";
}

export function hasNoPrettierParser(info: ToolRun): boolean {
  return !info.code && jsonObject(info.stdout).inferredParser === null;
}

export function passPartialPrettierResult(run: ToolRun): ToolRun {
  return { ...run, out: "", code: 0 };
}

export function failPartialPrettierResult(path: string, run: ToolRun): ToolRun {
  const why = !run.code
    ? "The staged file differs from Prettier's output. Format the file with Prettier, stage the formatted edits, and retry the commit.\n"
    : run.out;
  return {
    ...run,
    out: `[check:staged] prettier: ${path} as staged\n${why}`,
    code: run.code || 1,
  };
}

export function resolvePartialToolResult(tool: string, path: string, run: ToolRun): ToolRun {
  if (!run.code && !run.rules?.length) return { ...run, out: "", code: 0 };
  return { ...run, out: `[check:staged] ${tool}: ${path} as staged\n${run.out}` };
}

export function findDifferingScript(
  stagedScripts: Record<string, string> | undefined,
  workingScripts: Record<string, string> | undefined,
): string | undefined {
  return Object.keys({ ...stagedScripts, ...workingScripts }).find(
    (name) => stagedScripts?.[name] !== workingScripts?.[name],
  );
}
