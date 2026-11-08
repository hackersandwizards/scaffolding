import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";

const SCRIPT = resolve(import.meta.dirname, "../bin/check-lock.ts");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const lockPath = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "check-lock-")));
  roots.push(root);
  return join(root, "check.lock");
};

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

const run = (lock: string, args: string[], env: Record<string, string> = {}): Run => {
  try {
    return {
      status: 0,
      stdout: execFileSync("bun", [SCRIPT, ...args], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CHECK_LOCK: lock, ...env },
        // A wait that never ends would otherwise hang the test past the runner's own timeout.
        timeout: 20_000,
      }),
      stderr: "",
    };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
  }
};

const heldBy = (lock: string, pid: number): void =>
  writeFileSync(lock, JSON.stringify({ pid, startedAt: Date.now() }));

// A non-blocking open for writing succeeds only once a reader has the FIFO open; a blocking one
// would hang the whole run, past the test's timeout, when a regression never opens it.
const openWriter = async (fifo: string): Promise<number> => {
  for (const end = Date.now() + 5_000; Date.now() < end;) {
    try {
      return openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch {
      await new Promise((go) => setTimeout(go, 50));
    }
  }
  throw new Error(`no reader opened ${fifo}`);
};

const until = async (ok: () => boolean, ms: number): Promise<void> => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end;)
    await new Promise((go) => setTimeout(go, 50));
};

describe("check-lock serialises the checks", () => {
  // `spawn`, not `execFileSync`: synchronous children would serialise themselves and the assertion
  // would hold with no lock at all.
  it("never lets two runs overlap", async () => {
    const lock = lockPath();
    const [inside, breach] = [`${lock}.inside`, `${lock}.breach`];
    const body = `if [ -e ${inside} ]; then : > ${breach}; fi; : > ${inside}; sleep 0.3; rm -f ${inside}`;

    await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<void>((done, fail) => {
            const child = spawn("bun", [SCRIPT, "sh", "-c", body], {
              env: { ...process.env, CHECK_LOCK: lock },
              stdio: "ignore",
            });
            child.on("error", fail);
            child.on("close", () => done());
          }),
      ),
    );

    expect(existsSync(breach)).toBe(false);
    expect(existsSync(inside)).toBe(false);
  }, 60_000);

  // A FIFO at the lock path holds the waiter inside its read until the fresh lock has replaced the
  // name, then hands it the stale contents.
  it("never deletes a fresh lock written after it read the stale one", async () => {
    const lock = lockPath();
    execFileSync("mkfifo", [lock]);
    const fresh = `${lock}.fresh`;
    heldBy(fresh, process.pid);

    const child = spawn("bun", [SCRIPT, "echo", "ran"], {
      env: { ...process.env, CHECK_LOCK: lock, CHECK_LOCK_WAIT_MS: "1500" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    const status = new Promise<number | null>((done) => child.on("close", done));

    // Blocks until the waiter has opened the FIFO to read the holder.
    const pipe = await openWriter(lock);
    renameSync(fresh, lock);
    writeSync(pipe, JSON.stringify({ pid: 999_999, startedAt: Date.now() }));
    closeSync(pipe);

    expect(await status).toBe(1);
    expect(stdout).not.toContain("ran");
    expect(JSON.parse(readFileSync(lock, "utf-8")).pid).toBe(process.pid);
  }, 30_000);

  // The bug: a waiter paused past the claim's age bound right after its re-read; a second waiter
  // cleared the claim as a dead waiter's, reclaimed the stale lock and took a fresh one, and the
  // first then deleted that fresh lock and ran beside it. A FIFO holds the first waiter inside its
  // re-read, standing in for the pause, while the claim is aged and the second waiter polls.
  it("never clears a live waiter's claim, however old", async () => {
    const lock = lockPath();
    const fifo = `${lock}.fifo`;
    const [inside, breach] = [`${lock}.inside`, `${lock}.breach`];
    const body = (hold: number) =>
      `if [ -e ${inside} ]; then : > ${breach}; fi; : > ${inside}; sleep ${hold}; rm -f ${inside}`;
    const stale = JSON.stringify({ pid: 999_999, startedAt: 1 });
    const claim = `${lock}.reclaim-${createHash("sha1").update(stale).digest("hex")}.0`;
    const start = (hold: number, env: Record<string, string>) => {
      const child = spawn("bun", [SCRIPT, "sh", "-c", body(hold)], {
        env: { ...process.env, CHECK_LOCK: lock, ...env },
        stdio: "ignore",
      });
      return new Promise<number | null>((done) => child.on("close", done));
    };

    execFileSync("mkfifo", [lock]);
    const first = start(0.5, { CHECK_LOCK_WAIT_MS: "20000" });
    // First read: the stale holder.
    let pipe = await openWriter(lock);
    writeSync(pipe, stale);
    closeSync(pipe);
    // The first waiter now holds the claim and blocks opening the FIFO for its re-read.
    await until(() => existsSync(claim), 5_000);
    expect(existsSync(claim)).toBe(true);
    // The claim lands just before the re-read opens the FIFO.
    await new Promise((go) => setTimeout(go, 300));
    renameSync(lock, fifo);
    writeFileSync(lock, stale);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(claim, old, old);

    const second = start(3, { CHECK_LOCK_WAIT_MS: "20000" });
    // Long enough for the second waiter to clear an aged claim, reclaim and start its run.
    await until(() => existsSync(inside), 6_000);
    pipe = await openWriter(fifo);
    writeSync(pipe, stale);
    closeSync(pipe);

    await Promise.all([first, second]);
    expect(existsSync(breach)).toBe(false);
  }, 60_000);

  // A FIFO at the dead claim holds the slower waiter inside its read of the owner while the faster
  // takes its claim.
  it("never deletes the claim a live waiter took after a dead one", async () => {
    const lock = lockPath();
    heldBy(lock, 999_999);
    const base = `${lock}.reclaim-${createHash("sha1").update(readFileSync(lock)).digest("hex")}`;
    execFileSync("mkfifo", [`${base}.0`]);
    const child = spawn("bun", [SCRIPT, "echo", "ran"], {
      env: { ...process.env, CHECK_LOCK: lock, CHECK_LOCK_WAIT_MS: "1500" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    const status = new Promise<number | null>((done) => child.on("close", done));

    const pipe = await openWriter(`${base}.0`);
    writeFileSync(`${base}.1`, String(process.pid));
    writeSync(pipe, "999998");
    closeSync(pipe);
    // Later polls read a plain dead claim instead of blocking on the FIFO.
    writeFileSync(`${lock}.dead`, "999998");
    renameSync(`${lock}.dead`, `${base}.0`);

    expect(await status).toBe(1);
    expect(stdout).not.toContain("ran");
    expect(readFileSync(`${base}.1`, "utf-8")).toBe(String(process.pid));
    expect(JSON.parse(readFileSync(lock, "utf-8")).pid).toBe(999_999);
  }, 30_000);

  it("releases the lock when the run finishes", () => {
    const lock = lockPath();
    run(lock, ["true"]);
    expect(() => readFileSync(lock)).toThrow();
  });

  it("reports the command's exit code rather than its own, and names it on stdout", () => {
    const result = run(lockPath(), ["sh", "-c", "exit 3"]);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("failed (exit 3)");
  });

  it("names the signal that killed the command, which reports no exit code of its own", () => {
    const result = run(lockPath(), ["sh", "-c", "kill -9 $$"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("failed (killed by SIGKILL)");
  });

  it("fails without running once the wait is exhausted, and leaves the live holder's lock alone", () => {
    const lock = lockPath();
    heldBy(lock, process.pid);
    const result = run(lock, ["echo", "ran"], { CHECK_LOCK_WAIT_MS: "1500" });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("ran");
    expect(result.stderr).toContain(`pid ${process.pid} still holds`);
    expect(JSON.parse(readFileSync(lock, "utf-8")).pid).toBe(process.pid);
  }, 30_000);

  it("refuses a wait that is not a number instead of waiting forever", () => {
    const lock = lockPath();
    heldBy(lock, process.pid);
    const result = run(lock, ["echo", "ran"], { CHECK_LOCK_WAIT_MS: "15min" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CHECK_LOCK_WAIT_MS");
    expect(result.stdout).not.toContain("ran");
  }, 30_000);

  // A hung or slow holder past any age bound is still running: reclaiming it on age alone let two
  // checks overlap whenever a run outlasted ten minutes under load.
  it("never reclaims a live holder's lock on age alone", () => {
    const lock = lockPath();
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 11 * 60_000 }));
    const result = run(lock, ["echo", "ran"], { CHECK_LOCK_WAIT_MS: "1500" });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("ran");
  }, 30_000);
});

describe("check-lock wraps a consumer's build", () => {
  it("holds a build back until the running check has finished", async () => {
    const lock = lockPath();
    const done = `${lock}.check-done`;
    const check = spawn("bun", [SCRIPT, "sh", "-c", `sleep 1; : > ${done}`], {
      env: { ...process.env, CHECK_LOCK: lock },
      stdio: "ignore",
    });
    const finished = new Promise((go) => check.on("close", go));
    await until(() => existsSync(lock), 5_000);
    expect(existsSync(lock)).toBe(true);

    const build = run(lock, ["sh", "-c", `test -e ${done} && echo built`]);
    await finished;
    expect(build.status).toBe(0);
    expect(build.stdout).toBe("built\n");
  }, 30_000);

  // The gate's own catalog step and a Playwright webServer inside it run the wrapped build.
  it("runs a build nested inside a locked command at once", () => {
    const lock = lockPath();
    const result = run(lock, ["bun", SCRIPT, "echo", "built"], { CHECK_LOCK_WAIT_MS: "1500" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("built\n");
  }, 30_000);

  it("still takes the lock a different checkout's command holds", () => {
    const lock = lockPath();
    heldBy(lock, process.pid);
    const result = run(lock, ["echo", "built"], {
      CHECK_LOCK_WAIT_MS: "1500",
      SCAFFOLDING_LOCKED: `${lock}.other`,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("built");
  }, 30_000);

  // Killing check-lock alone left the build running beside a lock whose dead holder read as stale,
  // and a terminal's Ctrl-C ended check-lock before a build still shutting down had exited.
  for (const [how, signal, group] of [
    ["a kill of check-lock alone", "SIGTERM", false],
    ["a Ctrl-C to the whole process group", "SIGINT", true],
  ] as const)
    it(`holds the lock until the build has exited after ${how}`, async () => {
      const lock = lockPath();
      const pidFile = `${lock}.child`;
      // The build sits under a shell, as in `check-lock sh -c 'cd catalog && astro build'`, and
      // takes a second to shut down. The trailing `:` keeps a shell that execs its last command.
      const build = `echo $$ > ${pidFile}; trap 'sleep 1; exit 1' INT TERM; while :; do sleep 0.1; done`;
      const wrapped = ["sh", "-c", 'cd . && sh -c "$1"; :', "sh", build];
      const check = spawn("bun", [SCRIPT, ...wrapped], {
        env: { ...process.env, CHECK_LOCK: lock },
        stdio: "ignore",
        detached: group,
      });
      const finished = new Promise<NodeJS.Signals | null>((go) =>
        check.on("close", (_, how) => go(how)),
      );
      await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"), 5_000);
      const child = Number(readFileSync(pidFile, "utf8"));
      process.kill(group ? -check.pid! : check.pid!, signal);
      // A regression must fail here, not hang the run or leave the build behind.
      const died = await Promise.race([finished, Bun.sleep(10_000).then(() => "hung")]);
      const alive = (() => {
        try {
          process.kill(child, 0);
          return true;
        } catch {
          return false;
        }
      })();
      for (const pid of [check.pid!, child])
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      expect(alive).toBe(false);
      expect(died).toBe(signal);
      expect(existsSync(lock)).toBe(false);
    }, 30_000);

  // A CI cancel or a harness timeout SIGKILLs the caller's group, which the command's own group
  // escapes: the next run must wait for that group, not read the dead holder as stale.
  it("holds a build back while the command of a SIGKILLed holder still runs", async () => {
    const lock = lockPath();
    const done = `${lock}.build-done`;
    const check = spawn("bun", [SCRIPT, "sh", "-c", `sleep 3; : > ${done}`], {
      env: { ...process.env, CHECK_LOCK: lock },
      stdio: "ignore",
      detached: true,
    });
    await until(() => existsSync(lock) && readFileSync(lock, "utf8").includes("group"), 5_000);
    expect(readFileSync(lock, "utf8")).toContain('"group"');
    // Reaped first: a zombie holder would read as live through its pid alone.
    const reaped = new Promise((go) => check.on("close", go));
    process.kill(-check.pid!, "SIGKILL");
    await reaped;
    const next = run(lock, ["sh", "-c", `test -e ${done} && echo built`], {
      CHECK_LOCK_WAIT_MS: "15000",
    });
    expect(next.status).toBe(0);
    expect(next.stdout).toBe("built\n");
  }, 30_000);

  it("names a command that cannot start", () => {
    const result = run(lockPath(), ["no-such-command-here"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("not found");
    expect(result.stdout).not.toContain("output above");
  });
});

describe("check-lock fails open", () => {
  it("reclaims a lock whose holder is gone", () => {
    const lock = lockPath();
    heldBy(lock, 999_999);
    expect(run(lock, ["echo", "ran"]).stdout).toContain("ran");
  });

  it("reclaims a stale lock past a claim its waiter died holding", () => {
    const lock = lockPath();
    heldBy(lock, 999_999);
    const claim = `${lock}.reclaim-${createHash("sha1").update(readFileSync(lock)).digest("hex")}.0`;
    writeFileSync(claim, "999998");
    const result = run(lock, ["echo", "ran"], { CHECK_LOCK_WAIT_MS: "6000" });
    expect(result.stdout).toContain("ran");
  }, 30_000);

  // A claim whose owner is alive is a waiter mid-reclaim: removing it reopens the race it closes.
  it("leaves a fresh claim alone", () => {
    const lock = lockPath();
    heldBy(lock, 999_999);
    const claim = `${lock}.reclaim-${createHash("sha1").update(readFileSync(lock)).digest("hex")}.0`;
    writeFileSync(claim, String(process.pid));
    const result = run(lock, ["echo", "ran"], { CHECK_LOCK_WAIT_MS: "1500" });
    expect(result.stdout).not.toContain("ran");
    expect(existsSync(claim)).toBe(true);
  }, 30_000);

  it("reclaims a lock it cannot parse", () => {
    const lock = lockPath();
    writeFileSync(lock, "not json");
    expect(run(lock, ["echo", "ran"]).stdout).toContain("ran");
  });

  it("runs immediately when the lock path is unusable", () => {
    const started = Date.now();
    const result = run("/nonexistent-directory/impossible.lock", ["echo", "ran"]);
    expect(result.stdout).toContain("ran");
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});
