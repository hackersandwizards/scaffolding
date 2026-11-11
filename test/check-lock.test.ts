import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
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

const SCRIPT = resolve(import.meta.dirname, "../template/.githooks/check-lock.ts");

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

// A process starting on a loaded machine took more than 5 s to write its lock, and the read after
// a silent timeout failed on a file that was not there yet; so the wait is long and says when it
// runs out.
const until = async (ok: () => boolean, what: string): Promise<void> => {
  for (const end = Date.now() + 20_000; !ok(); await new Promise((go) => setTimeout(go, 50)))
    if (Date.now() > end) throw new Error(`still waiting for ${what} after 20 s`);
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
    await until(() => existsSync(claim), "the claim");
    // The claim lands just before the re-read opens the FIFO.
    await new Promise((go) => setTimeout(go, 300));
    renameSync(lock, fifo);
    writeFileSync(lock, stale);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(claim, old, old);

    const second = start(3, { CHECK_LOCK_WAIT_MS: "20000" });
    // Long enough for the second waiter to clear an aged claim, reclaim and start its run.
    // Unchecked: a regression starts the run here, which the breach below then shows.
    for (const end = Date.now() + 6_000; !existsSync(inside) && Date.now() < end;)
      await new Promise((go) => setTimeout(go, 50));
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

  // A first poll inside the millisecond it started measured a wait of 0, not above 0, and slept
  // 2 s: about one run in three. So ten runs, each read by the wait it reports, which a loaded
  // machine's slow start leaves alone.
  it("gives up at once under a wait of 0, without a poll's sleep", () => {
    const lock = lockPath();
    heldBy(lock, process.pid);
    for (let i = 0; i < 10; i++) {
      const result = run(lock, ["echo", "ran"], { CHECK_LOCK_WAIT_MS: "0" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`pid ${process.pid} still holds ${lock} after 0s`);
    }
  }, 30_000);

  it("waits under a wait of 0 for a holder running the same command", async () => {
    const lock = lockPath();
    const first = spawn("bun", [SCRIPT, "sh", "-c", "sleep 2"], {
      env: { ...process.env, CHECK_LOCK: lock },
      stdio: "ignore",
    });
    const done = new Promise((resolve) => first.on("close", resolve));
    await until(() => existsSync(lock), "the first holder");
    const same = run(lock, ["sh", "-c", "sleep 2"], { CHECK_LOCK_WAIT_MS: "0" });
    await done;
    expect(same.status).toBe(0);
    expect(same.stderr).toBe("");
  }, 30_000);

  it("lets a ticket that is not renewed hold a free lock for three polls, and removes a dead one", () => {
    const lock = lockPath();
    mkdirSync(`${lock}.queue`);
    // A ticket whose process waits for nothing, a pid reused or a waiter stopped by Ctrl-Z.
    const earlier = `${lock}.queue/000000000000001-${process.pid}`;
    writeFileSync(earlier, "");
    const started = Date.now();
    expect(run(lock, ["echo", "ran"], { CHECK_LOCK_WAIT_MS: "0" }).stdout).toBe("ran\n");
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_900);
    expect(existsSync(earlier)).toBe(false);
    writeFileSync(`${lock}.queue/000000000000001-999999`, "");
    expect(run(lock, ["echo", "ran"]).stdout).toBe("ran\n");
    expect(readdirSync(`${lock}.queue`)).toEqual([]);
  }, 30_000);

  // A waiter SIGKILLed while it waited left its ticket, and once its pid was reused the ticket read
  // as live: an install, waiting 0, gave up on a free lock after one poll.
  it("removes a ticket left unrenewed for three polls, whose pid another process now holds", () => {
    const lock = lockPath();
    mkdirSync(`${lock}.queue`);
    const ghost = `${lock}.queue/000000000000001-${process.pid}`;
    writeFileSync(ghost, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(ghost, old, old);
    const result = run(lock, ["echo", "ran"], { CHECK_LOCK_WAIT_MS: "0" });
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("ran\n");
    expect(readdirSync(`${lock}.queue`)).toEqual([]);
  }, 30_000);

  it("starts the wait again whenever the lock passes on", async () => {
    const lock = lockPath();
    const start = (command: string) =>
      new Promise<number | null>((done) =>
        spawn("bun", [SCRIPT, "sh", "-c", command], {
          env: { ...process.env, CHECK_LOCK: lock },
          stdio: "ignore",
        }).on("close", done),
      );
    const first = start("sleep 2");
    await until(() => existsSync(lock), "the first holder");
    const second = start("sleep 2");
    await until(
      () => existsSync(`${lock}.queue`) && readdirSync(`${lock}.queue`).length > 0,
      "the queue",
    );
    // Longer than either holder alone, shorter than both.
    const third = run(lock, ["echo", "ran"], { CHECK_LOCK_WAIT_MS: "3500" });
    expect(third.stdout).toBe("ran\n");
    expect(await first).toBe(0);
    expect(await second).toBe(0);
  }, 60_000);

  // Four installs at once: one that found the lock free at two polls in a row, the others taking
  // their turns in between, gave up although nobody held it.
  it("waits under a wait of 0 while the lock is free and a live waiter is ahead", async () => {
    const lock = lockPath();
    mkdirSync(`${lock}.queue`);
    const ahead = `${lock}.queue/000000000000001-${process.pid}`;
    writeFileSync(ahead, "");
    const child = spawn("bun", [SCRIPT, "echo", "ran"], {
      env: { ...process.env, CHECK_LOCK: lock, CHECK_LOCK_WAIT_MS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let [stdout, stderr] = ["", ""];
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    const status = new Promise<number | null>((done) => child.on("close", done));
    await until(() => readdirSync(`${lock}.queue`).length > 1, "the waiter's ticket");
    // The waiter ahead renews its ticket for three polls, then leaves.
    for (let i = 0; i < 6; i++) {
      writeFileSync(ahead, "");
      await new Promise((go) => setTimeout(go, 1_000));
    }
    expect(child.exitCode).toBe(null);
    expect(stdout).toBe("");
    rmSync(ahead);
    expect(await status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("ran\n");
  }, 30_000);

  // A waiter that was not first read a dead holder's lock, or one that did not parse, as another
  // command and gave up on it, while the waiter ahead was reclaiming it.
  for (const [what, contents] of [
    ["a dead holder's lock", JSON.stringify({ pid: 999_999, startedAt: 1, command: ["other"] })],
    ["a lock that does not parse", "not json"],
  ])
    it(`waits under a wait of 0 behind a waiter ahead that reclaims ${what}`, async () => {
      const lock = lockPath();
      mkdirSync(`${lock}.queue`);
      const ahead = `${lock}.queue/000000000000001-${process.pid}`;
      writeFileSync(ahead, "");
      writeFileSync(lock, contents);
      const child = spawn("bun", [SCRIPT, "echo", "ran"], {
        env: { ...process.env, CHECK_LOCK: lock, CHECK_LOCK_WAIT_MS: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let [stdout, stderr] = ["", ""];
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
      const status = new Promise<number | null>((done) => child.on("close", done));
      // The waiter ahead renews its ticket, however slow the waiter's start.
      const renew = setInterval(() => writeFileSync(ahead, ""), 1_000);
      await until(
        () => readdirSync(`${lock}.queue`).length > 1 || child.exitCode !== null,
        "the waiter's ticket",
      );
      await new Promise((go) => setTimeout(go, 1_000));
      clearInterval(renew);
      expect(child.exitCode).toBe(null);
      // The waiter ahead reclaims the lock and leaves.
      rmSync(lock);
      rmSync(ahead);
      expect(await status).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toBe("ran\n");
    }, 30_000);

  // The queue folder removed while a waiter waited, or a ticket it could not remove, failed the
  // poll, and the command ran beside the live holder as if the lock were unusable.
  for (const [what, disturb] of [
    ["the queue folder is removed", (queue: string) => rmSync(queue, { recursive: true })],
    ["a ticket it cannot remove", (queue: string) => mkdirSync(`${queue}/000000000000001-999999`)],
    [
      "the queue path becomes a file",
      (queue: string) => {
        rmSync(queue, { recursive: true });
        writeFileSync(queue, "");
      },
    ],
  ] as const)
    it(`keeps waiting behind a live holder when ${what}`, async () => {
      const lock = lockPath();
      heldBy(lock, process.pid);
      const child = spawn("bun", [SCRIPT, "echo", "ran"], {
        env: { ...process.env, CHECK_LOCK: lock },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let [stdout, stderr] = ["", ""];
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
      const status = new Promise<number | null>((done) => child.on("close", done));
      await until(
        () => existsSync(`${lock}.queue`) && readdirSync(`${lock}.queue`).length > 0,
        "the ticket",
      );
      disturb(`${lock}.queue`);
      await new Promise((go) => setTimeout(go, 4_500));
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      rmSync(lock);
      expect(await status).toBe(0);
      expect(stdout).toBe("ran\n");
    }, 30_000);

  // A ticket it could not remove ended the poll's reading of the queue, so every waiter read itself
  // as first and took a free lock ahead of a live waiter.
  it("keeps its place behind a live waiter ahead when a ticket cannot be removed", async () => {
    const lock = lockPath();
    mkdirSync(`${lock}.queue/000000000000001-999999`, { recursive: true });
    const ahead = `${lock}.queue/000000000000002-${process.pid}`;
    writeFileSync(ahead, "");
    const renew = setInterval(() => writeFileSync(ahead, ""), 1_000);
    const child = spawn("bun", [SCRIPT, "echo", "ran"], {
      env: { ...process.env, CHECK_LOCK: lock },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    const status = new Promise<number | null>((done) => child.on("close", done));
    try {
      await until(() => readdirSync(`${lock}.queue`).length > 2, "the waiter's ticket");
      await new Promise((go) => setTimeout(go, 3_000));
      expect(stdout).toBe("");
    } finally {
      clearInterval(renew);
      rmSync(ahead, { force: true });
    }
    expect(await status).toBe(0);
    expect(stdout).toBe("ran\n");
  }, 30_000);

  it("gives up under a wait of 0 on a lock path that holds no readable holder", () => {
    const lock = lockPath();
    mkdirSync(lock);
    const result = run(lock, ["echo", "ran"], { CHECK_LOCK_WAIT_MS: "0" });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("ran");
  }, 30_000);

  it("reads an empty wait as the default, not as a wait of 0", async () => {
    const lock = lockPath();
    heldBy(lock, process.pid);
    const child = spawn("bun", [SCRIPT, "echo", "ran"], {
      env: { ...process.env, CHECK_LOCK: lock, CHECK_LOCK_WAIT_MS: "" },
      stdio: "ignore",
    });
    let exited = false;
    child.on("exit", () => (exited = true));
    await new Promise((go) => setTimeout(go, 3_000));
    expect(exited).toBe(false);
    child.kill("SIGKILL");
  }, 30_000);

  // annotate() renames a new file over the lock when the command starts and when a signal reaches
  // it; a waiter read each new inode as a new holder and started its wait again.
  it("keeps counting the wait when the holder rewrites its own lock", async () => {
    const lock = lockPath();
    const holder = { pid: process.pid, startedAt: Date.now(), command: ["other"] };
    writeFileSync(lock, JSON.stringify(holder));
    const child = spawn("bun", [SCRIPT, "echo", "ran"], {
      env: { ...process.env, CHECK_LOCK: lock, CHECK_LOCK_WAIT_MS: "4000" },
      stdio: "ignore",
    });
    const exit = new Promise((done) => child.on("exit", done));
    await until(
      () => existsSync(`${lock}.queue`) && readdirSync(`${lock}.queue`).length > 0,
      "the ticket",
    );
    const waiting = Date.now();
    await new Promise((go) => setTimeout(go, 3_000));
    writeFileSync(`${lock}.new`, JSON.stringify({ ...holder, signalled: true }));
    renameSync(`${lock}.new`, lock);
    expect(await exit).toBe(1);
    // About 4 s; a wait started again at the rewrite ends about 8 s after the ticket.
    expect(Date.now() - waiting).toBeLessThan(6_500);
  }, 30_000);

  // An empty lock path was unusable, and the command ran unserialised.
  it("reads an empty CHECK_LOCK as unset, taking the checkout's lock", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "check-lock-")));
    roots.push(dir);
    mkdirSync(join(dir, "node_modules"));
    heldBy(join(dir, "node_modules/.check.lock"), process.pid);
    const result = spawnSync("bun", [SCRIPT, "echo", "ran"], {
      cwd: dir,
      env: { ...process.env, CHECK_LOCK: "", CHECK_LOCK_WAIT_MS: "0" },
      encoding: "utf8",
    });
    expect(result.stdout).not.toContain("ran");
    expect(result.stderr).toContain(`pid ${process.pid} still holds`);
  });

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
    await until(() => existsSync(lock), "the lock");

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
      const build = `trap 'sleep 1; exit 1' INT TERM; echo $$ > ${pidFile}; while :; do sleep 0.1; done`;
      const wrapped = ["sh", "-c", 'cd . && sh -c "$1"; :', "sh", build];
      const check = spawn("bun", [SCRIPT, ...wrapped], {
        env: { ...process.env, CHECK_LOCK: lock },
        stdio: "ignore",
        detached: group,
      });
      const finished = new Promise<NodeJS.Signals | null>((go) =>
        check.on("close", (_, how) => go(how)),
      );
      await until(
        () => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"),
        "the build's pid",
      );
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
  // escapes: the next run must wait for that command, not read the dead holder as stale.
  it("holds a build back while the command of a SIGKILLed holder still runs", async () => {
    const lock = lockPath();
    const done = `${lock}.build-done`;
    const check = spawn("bun", [SCRIPT, "sh", "-c", `sleep 3; : > ${done}`], {
      env: { ...process.env, CHECK_LOCK: lock },
      stdio: "ignore",
      detached: true,
    });
    await until(
      () => existsSync(lock) && readFileSync(lock, "utf8").includes("group"),
      "the command's group in the lock",
    );
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

  // A command may leave a process behind on purpose: that group member holds nothing.
  it("reclaims the lock of a SIGKILLed holder once its command has exited", async () => {
    const lock = lockPath();
    const check = spawn("bun", [SCRIPT, "sh", "-c", "sleep 30 & sleep 1"], {
      env: { ...process.env, CHECK_LOCK: lock },
      stdio: "ignore",
      detached: true,
    });
    await until(
      () => existsSync(lock) && readFileSync(lock, "utf8").includes("group"),
      "the command's group in the lock",
    );
    const { group } = JSON.parse(readFileSync(lock, "utf8")) as { group: number };
    const reaped = new Promise((go) => check.on("close", go));
    process.kill(-check.pid!, "SIGKILL");
    await reaped;
    try {
      const next = run(lock, ["echo", "ran"], { CHECK_LOCK_WAIT_MS: "10000" });
      expect(next.stdout).toContain("ran");
    } finally {
      process.kill(-group, "SIGKILL");
    }
  }, 30_000);

  // A shell dies at once on the signal while the build it started shuts down after it.
  it("after a signal holds a SIGKILLed holder's lock until the command's group is empty", async () => {
    const lock = lockPath();
    const [ready, done] = [`${lock}.build-ready`, `${lock}.build-done`];
    // The build says when it ignores TERM: a signal before its trap ended it at once.
    const check = spawn(
      "bun",
      [SCRIPT, "sh", "-c", `(trap '' TERM; : > ${ready}; sleep 3; : > ${done}) & wait`],
      { env: { ...process.env, CHECK_LOCK: lock }, stdio: "ignore", detached: true },
    );
    await until(() => existsSync(ready), "the build's trap");
    await until(
      () => existsSync(lock) && readFileSync(lock, "utf8").includes("group"),
      "the command's group in the lock",
    );
    check.kill("SIGTERM");
    await until(() => readFileSync(lock, "utf8").includes("signalled"), "the signal in the lock");
    const reaped = new Promise((go) => check.on("close", go));
    check.kill("SIGKILL");
    await reaped;
    const next = run(lock, ["sh", "-c", `test -e ${done} && echo built`], {
      CHECK_LOCK_WAIT_MS: "15000",
    });
    expect(next.stdout).toBe("built\n");
  }, 60_000);

  it("ends the group of a command killed on its own before it lets the lock go", async () => {
    const lock = lockPath();
    const [pidFile, done] = [`${lock}.pid`, `${lock}.step-done`];
    const check = spawn(
      "bun",
      [SCRIPT, "sh", "-c", `(sleep 3; : > ${done}) & echo $$ > ${pidFile}; wait`],
      { env: { ...process.env, CHECK_LOCK: lock }, stdio: "ignore" },
    );
    const finished = new Promise((go) => check.on("close", go));
    await until(
      () => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"),
      "the pid",
    );
    process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
    await finished;
    expect(existsSync(lock)).toBe(false);
    await Bun.sleep(4_000);
    expect(existsSync(done)).toBe(false);
  }, 60_000);

  it("kills a group that outlives a lone signal, so the lock is not held for ever", async () => {
    const lock = lockPath();
    const pidFile = `${lock}.pid`;
    const check = spawn(
      "bun",
      [SCRIPT, "sh", "-c", `(trap '' TERM; sleep 60) & echo $$ > ${pidFile}; wait`],
      { env: { ...process.env, CHECK_LOCK: lock }, stdio: "ignore" },
    );
    const finished = new Promise((go) => check.on("close", go));
    await until(
      () => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"),
      "the pid",
    );
    const sent = Date.now();
    process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
    await finished;
    expect(Date.now() - sent).toBeLessThan(30_000);
    expect(existsSync(lock)).toBe(false);
  }, 90_000);

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

  it.skipIf(process.getuid?.() === 0)("reads a live holder of another user as live", () => {
    const lock = lockPath();
    heldBy(lock, 1);
    const result = run(lock, ["echo", "ran"], { CHECK_LOCK_WAIT_MS: "1500" });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("ran");
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
