import { spawn } from "node:child_process";
import { SIGNALS } from "./repo.ts";

export type StepResult = { name: string; code: number; ms: number };
export type GateStep = [string, string];

export function formatStepLine(result: StepResult): string {
  return `[scaffolding] ${result.code ? "FAIL" : "ok  "} ${result.name} ${(result.ms / 1000).toFixed(1)} s`;
}

export function stepConcurrencyLimit(load: number, cores: number): number {
  // Above one waiting process per core, the tests and the build run one after another once the quick
  // shared checks have run side by side: started all at once on a loaded machine, they starved each
  // other past every fixed limit inside them, and a correct tree went red. The repository's steps then
  // run `width` at a time: the cores times the share of a core each waiting process gets, at least 2.
  return load > cores ? Math.max(2, Math.floor((cores * cores) / load)) : Infinity;
}

export function reportStoppedStep(name: string, out: string, signal: NodeJS.Signals): void {
  process.stderr.write(out);
  console.error(`[scaffolding] stopped ${name} by ${signal}`);
}

export class GateStepRunner {
  readonly results: StepResult[] = [];
  private readonly running = new Map<string, { out: string }>();
  private readonly root: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly width: number;

  constructor(root: string, env: NodeJS.ProcessEnv, width: number) {
    this.root = root;
    this.env = env;
    this.width = width;
  }

  installSignalHandlers(): void {
    // A signal ends the steps through check-lock, which signals the whole group; this prints what the
    // running ones said so far and names them, then dies by the same signal.
    for (const signal of SIGNALS)
      process.on(signal, () => {
        for (const [name, step] of this.running) reportStoppedStep(name, step.out, signal);
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      });
  }

  // A step is reported the moment it ends, its output ahead of its line, so a red step shows at once
  // rather than after its slowest sibling, and a gate cut off still shows every step that ended.
  runStep(name: string, command: string, buffered: boolean): Promise<StepResult> {
    const begun = performance.now();
    const step = { out: "" };
    this.running.set(name, step);
    return new Promise((done) => {
      const child = spawn("sh", ["-c", command], {
        cwd: this.root,
        env: this.env,
        stdio: buffered ? ["ignore", "pipe", "pipe"] : "inherit",
      });
      child.stdout?.on("data", (d) => (step.out += d));
      child.stderr?.on("data", (d) => (step.out += d));
      child.on("close", (code, signal) => {
        const result = { name, code: code ?? 1, ms: performance.now() - begun };
        const finish = () => {
          this.running.delete(name);
          process.stderr.write(step.out);
          console.error(formatStepLine(result));
          this.results.push(result);
          done(result);
        };
        // A group interrupt can close the child before this process handles the same signal.
        // Keep the step visible to the handler for one turn before treating its exit as a failure.
        if (signal && SIGNALS.some((interrupt) => interrupt === signal)) setImmediate(finish);
        else finish();
      });
    });
  }

  async runParallel(steps: readonly GateStep[]): Promise<boolean> {
    if (!Number.isFinite(this.width)) {
      const settled = await Promise.all(
        steps.map(([name, cmd]) => this.runStep(name, cmd, steps.length > 1)),
      );
      return settled.every((r) => r.code === 0);
    }
    const queue = [...steps];
    const settled: StepResult[] = [];
    // One at a time, a step writes straight to the terminal.
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [name, cmd] = next;
        settled.push(await this.runStep(name, cmd, this.width > 1 && steps.length > 1));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.width, queue.length) }, worker));
    return settled.every((r) => r.code === 0);
  }

  // A step named in `after` starts once the step it names, listed before it, has finished, passed
  // or failed. Under load the steps named in `quick` still run side by side, and the others then run
  // one at a time.
  async runOrdered(
    steps: readonly GateStep[],
    after: Record<string, string>,
    quick: ReadonlySet<string>,
  ): Promise<boolean> {
    const runs = new Map<string, Promise<StepResult>>();
    const start = (name: string, cmd: string, buffered: boolean) => {
      const first = runs.get(after[name] ?? "");
      runs.set(
        name,
        first
          ? first.then(() => this.runStep(name, cmd, buffered))
          : this.runStep(name, cmd, buffered),
      );
    };
    const loaded = Number.isFinite(this.width);
    const queue = loaded ? steps.filter(([name]) => !quick.has(name)) : [];
    const beside = steps.filter((step) => !queue.includes(step));
    for (const [name, cmd] of beside) start(name, cmd, steps.length > 1);
    if (queue.length) await Promise.all(runs.values());
    for (const [name, cmd] of queue) {
      start(name, cmd, false);
      await runs.get(name);
    }
    return (await Promise.all(runs.values())).every((r) => r.code === 0);
  }
}
