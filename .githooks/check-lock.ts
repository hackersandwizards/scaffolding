#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
// A skeleton file of @hackersandwizards/scaffolding at the version package.json pins: check-structure
// --fix writes it, and the gate fails a copy that differs unless `skip.structure` is set.

import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";
import {
  acquireCheckLock,
  CheckLockDeadline,
  dropIfStale,
  holderName,
  type Holder,
  inspectCheckLock,
  LOCK_POLL_MS,
  LOCK_TICKET_MS,
  readHolder,
  running,
} from "./check-lock-record.ts";

// Concurrent `bun run check` runs in one checkout corrupt each other: vitest workers spawn `bun`
// subprocesses whose module resolution reads files a parallel run is rewriting, and the spawned
// script dies part-way through its output. Serialising the runs removes the overlap. A broken lock
// falls through to running the checks, since it must never be the thing that stops work. A live
// holder past the wait fails instead: running beside it is the corruption this lock exists to stop.
// A consumer wraps its build in it too (`check-lock astro build`), since a build rewriting dist/
// while a gate step reads it fails that step. SCAFFOLDING_LOCKED names the lock the command's
// process tree holds, so a build the gate starts runs at once instead of waiting for its own gate,
// while one it starts in another checkout still takes that checkout's lock.

// `bun run` starts this from the repository root, for the gate and a wrapped build alike.
const LOCK = process.env.CHECK_LOCK || resolve("node_modules", ".check.lock");

// The longest one holder may keep a waiter waiting; the wait starts again whenever the lock passes
// on, so a queue of slow gates never runs it out, a hung holder does. Overridable so the test can
// prove the timeout without waiting it out.
const FULL_WAIT_MS = 15 * 60 * 1000;
// Empty is unset: Number("") is 0, which gives up at once.
const WAIT_MS = Number(process.env.CHECK_LOCK_WAIT_MS || FULL_WAIT_MS);
// NaN would never compare greater, and the wait would never end.
if (!Number.isFinite(WAIT_MS)) throw new Error("CHECK_LOCK_WAIT_MS must be a number of ms");
// The whole run, the wait for the lock included, in seconds; unset or 0 is unbounded.
const RUN_S = Number(process.env.CHECK_LOCK_RUN_S || 0);
if (!Number.isFinite(RUN_S)) throw new Error("CHECK_LOCK_RUN_S must be a number of seconds");
// From a signal the command took alone, or the end of RUN_S, to the SIGKILL of its group.
const KILL_MS = 10_000;
const SPEAK_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// Waiters take the lock in the order they came: each holds a ticket named for its arrival and
// renews it every poll, and only the first live one may take it, so a waiter polling at the right
// moment no longer overtakes one that has waited longer. A ticket whose pid is gone, or that went
// unrenewed for three polls (its pid reused by another process, its waiter stopped), is removed by
// the next waiter; a stopped waiter's next poll writes it again.
const QUEUE = `${LOCK}.queue`;
let ticket: string | undefined;
let wroteTicket = false;
function removeTicket(path: string) {
  try {
    unlinkSync(path);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
}
// The queue only orders the waiters; the lock keeps the commands apart. So a queue that fails, its
// folder removed or a ticket that cannot be removed, costs the order, never the lock.
function first(): boolean {
  try {
    mkdirSync(QUEUE, { recursive: true });
    writeFileSync(`${QUEUE}/${ticket}`, "");
    wroteTicket = true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "EEXIST" || code === "ENOENT" || code === "ENOTDIR") return true;
    throw error;
  }
  let names: string[];
  try {
    names = readdirSync(QUEUE);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return true;
    throw error;
  }
  const tickets = names.filter((name) => {
    const path = `${QUEUE}/${name}`;
    try {
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat?.isFile()) return false;
      if (running(Number(name.split("-")[1])) && Date.now() - stat.mtimeMs < LOCK_TICKET_MS)
        return true;
      removeTicket(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    }
    return false;
  });
  return tickets.sort()[0] === ticket;
}

let queueFailed = false;
function queueFailure(error: unknown): void {
  queueFailed = true;
  lockWarning("queue failed", error, "continuing without queue order");
}

function turn(): boolean {
  if (queueFailed) return true;
  try {
    return first();
  } catch (error) {
    queueFailure(error);
    return true;
  }
}

// process.exit skips a finally, so each exit while waiting hands the ticket back itself.
function leave(): void {
  if (!ticket || !wroteTicket) return;
  wroteTicket = false;
  try {
    removeTicket(`${QUEUE}/${ticket}`);
  } catch (error) {
    queueFailure(error);
  }
}

async function waitForLock(): Promise<boolean> {
  ticket = `${String(Date.now()).padStart(15, "0")}-${process.pid}`;
  try {
    return await queueForLock();
  } finally {
    leave();
  }
}

async function queueForLock(): Promise<boolean> {
  let started = Date.now();
  let spokeAt = 0;
  const deadline = new CheckLockDeadline(WAIT_MS, FULL_WAIT_MS);
  let holder = inspectCheckLock(LOCK).id;
  for (;;) {
    if (turn()) {
      if (acquireCheckLock(LOCK, command)) return true;
      dropIfStale(LOCK);
      if (acquireCheckLock(LOCK, command)) return true;
    }
    const now = inspectCheckLock(LOCK);
    if (now.id !== holder) [holder, started, spokeAt] = [now.id, Date.now(), 0];

    const waited = Date.now() - started;
    // At least: a first poll in the millisecond the wait began measures 0, and a wait of 0 slept.
    if (deadline.expired(now, waited, command)) {
      console.error(
        `[check-lock] ${holderName(now.read)} still holds ${LOCK} after ${Math.round(waited / 1000)}s; not running "${command.join(" ")}" beside it. Retry once it finishes.`,
      );
      leave();
      process.exit(1);
    }
    if (waited - spokeAt >= SPEAK_MS) {
      spokeAt = waited;
      console.warn(
        `[check-lock] waiting ${Math.round(waited / 1000)}s for ${holderName(now.read)} to finish`,
      );
    }
    await sleep(LOCK_POLL_MS);
  }
}

const command = process.argv.slice(2);
function lockWarning(phase: string, error: unknown, consequence: string): void {
  const detail = String(error).replace(/\s*\r?\n\s*/g, " ");
  console.warn(`[check-lock] ${phase} (${detail}); ${consequence}`);
}

// A skeleton file runs without the package beside it, so its help names where the rest stands.
const USAGE = "usage: check-lock <command> [args...]";
if (command[0] === "--help") {
  console.log(
    `${USAGE}\nRuns the command under the checkout's lock: docs/commands.md of @hackersandwizards/scaffolding.`,
  );
  process.exit(0);
}
if (command.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

// A signal's default action killed a waiter inside dropIfStale and left its claim for good once
// the stale lock was gone, and once the command runs it ended check-lock alone, so a build ran on
// beside a lock whose dead holder read as stale. One handler serves both phases, leaving no gap:
// while waiting it defers the signal to the event loop, after the claim's finally has removed it;
// while running it passes the signal to the command, and a second one kills it.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
let child: ChildProcess | undefined = undefined;
const killGroup = (signal: NodeJS.Signals) => {
  const pid = child?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
};
let received: NodeJS.Signals | undefined;
function onSignal(signal: NodeJS.Signals): void {
  if (!child) {
    leave();
    process.exit(128 + constants.signals[signal]);
  }
  killGroup(received ? "SIGKILL" : signal);
  if (!received) updateAnnotation({ signalled: true });
  received ??= signal;
}
for (const signal of SIGNALS) process.on(signal, onSignal);
// Past RUN_S the run stops as on SIGTERM, and its command is killed KILL_MS later; it exits 124,
// as timeout(1) does, since no interrupt reached it. A signal that came first keeps its own course.
let timedOut = false;
function stop(): void {
  if (received) return;
  console.error(
    `[check-lock] "${command.join(" ")}" not done after ${RUN_S} s (CHECK_LOCK_RUN_S): stopping it`,
  );
  if (!child) {
    leave();
    process.exit(124);
  }
  timedOut = true;
  onSignal("SIGTERM");
  setTimeout(() => killGroup("SIGKILL"), KILL_MS);
}
// setTimeout runs a delay past 2^31 - 1 ms (about 24.8 days) at once.
const bound = RUN_S > 0 ? setTimeout(stop, Math.min(RUN_S * 1000, 2 ** 31 - 1)) : undefined;
let held = false;
try {
  if (process.env.SCAFFOLDING_LOCKED !== LOCK) held = await waitForLock();
} catch (error) {
  lockWarning("lock unusable", error, `running "${command.join(" ")}" unserialised`);
}

/** Rewrites this run's lock with `fields`, whole through a rename, as create() writes it. */
function annotate(fields: Partial<Holder>): void {
  const holder = held ? readHolder(LOCK) : undefined;
  if (holder?.pid !== process.pid) return;
  writeFileSync(`${LOCK}.${process.pid}`, JSON.stringify({ ...holder, ...fields }));
  try {
    renameSync(`${LOCK}.${process.pid}`, LOCK);
  } finally {
    rmSync(`${LOCK}.${process.pid}`, { force: true });
  }
}

let annotationFailed = false;
function updateAnnotation(fields: Partial<Holder>): void {
  if (annotationFailed) return;
  try {
    annotate(fields);
  } catch (error) {
    annotationFailed = true;
    lockWarning("lock annotation failed", error, "the command continues with the last lock record");
  }
}

function release(): void {
  try {
    if (held && readHolder(LOCK)?.pid === process.pid) rmSync(LOCK, { force: true });
  } catch (error) {
    // The next waiter can reclaim this lock once its holder is gone.
    lockWarning("lock release failed", error, "the command ran and keeps its exit status");
  }
}

// Passing the signal to the command alone was not enough: `sh -c 'cd catalog && astro build'` died
// and left the build running. So the command runs in its own process group (detached, which also
// gives up the terminal: opening /dev/tty fails), the handler signals that group, and after a
// signal the lock is released once the group is empty.
child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env: { ...process.env, SCAFFOLDING_LOCKED: LOCK },
  detached: true,
});
// The command's own group escapes a SIGKILL to the caller's group, so the lock names the command
// too, and a waiter reads it as live until the command has exited.
if (child.pid) updateAnnotation({ group: child.pid });
const result = await new Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}>((done) => {
  child.on("error", (error) => done({ status: null, signal: null, error }));
  child.on("exit", (status, signal) => done({ status, signal }));
});
clearTimeout(bound);
// A command killed by a signal sent to it alone, not to check-lock, left its steps running in its
// group while the lock was released; so the rest of the group gets the same signal. Only after a
// signal: a command that exits on its own may leave a process behind on purpose.
if (result.signal && !received) {
  updateAnnotation({ signalled: true });
  killGroup(result.signal);
}
const stoppedAt = Date.now();
while (child.pid && (received || result.signal) && running(-child.pid)) {
  // After a signal the command took alone, nobody sends the second one that kills: KILL_MS do.
  if (!received && Date.now() - stoppedAt > KILL_MS) killGroup("SIGKILL");
  await sleep(100);
}
release();
if (result.error)
  console.log(`[check-lock] ${command.join(" ")} did not start: ${result.error.message}`);
else if (result.status !== 0) {
  const cause = result.signal ? `killed by ${result.signal}` : `exit ${result.status}`;
  console.log(
    `[check-lock] ${command.join(" ")} failed (${cause}). Its own output above says why.`,
  );
}
// Dying by the signal tells the calling shell it was an interrupt, so a loop of builds stops.
if (timedOut) process.exit(124);
if (received) {
  process.removeAllListeners(received);
  process.kill(process.pid, received);
}
// A signalled child reports a null status, and exiting 0 there would hide a killed gate.
process.exit(result.status ?? 1);
