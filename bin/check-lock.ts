#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";

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
const LOCK = process.env.CHECK_LOCK ?? resolve("node_modules", ".check.lock");

// The longest one holder may keep a waiter waiting; the wait starts again whenever the lock passes
// on, so a queue of slow gates never runs it out, a hung holder does. Overridable so the test can
// prove the timeout without waiting it out.
const FULL_WAIT_MS = 15 * 60 * 1000;
const WAIT_MS = Number(process.env.CHECK_LOCK_WAIT_MS ?? FULL_WAIT_MS);
// NaN would never compare greater, and the wait would never end.
if (!Number.isFinite(WAIT_MS)) throw new Error("CHECK_LOCK_WAIT_MS must be a number of ms");
const POLL_MS = 2_000;
const SPEAK_MS = 30_000;

interface Holder {
  pid: number;
  startedAt: number;
  /** The command it runs, read by a waiter for the same one. */
  command?: string[];
  /** The command's pid, the leader of its own process group: it outlives a holder killed together
   * with its caller's group. */
  group?: number;
  /** A signal reached the command: its whole group counts, since a shell dies at once and the build
   * it started shuts down after it. */
  signalled?: true;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function readLock(): string | undefined {
  try {
    return readFileSync(LOCK, "utf8");
  } catch {
    return undefined;
  }
}

function parseHolder(raw: string | undefined): Holder | undefined {
  try {
    const holder = JSON.parse(raw ?? "") as Holder;
    if (typeof holder.pid !== "number") return undefined;
    // kill(-1) and kill(0) address every process or this one's group, never the command's.
    if (!(Number.isInteger(holder.group) && holder.group! > 1)) delete holder.group;
    return holder;
  } catch {
    return undefined;
  }
}

const readHolder = (): Holder | undefined => parseHolder(readLock());
const holderName = (): string => {
  const holder = readHolder();
  if (!holder) return "pid unknown";
  return holder.group && !running(holder.pid)
    ? `command ${holder.group} of dead pid ${holder.pid}`
    : `pid ${holder.pid}`;
};

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive, under another user.
    return (error as { code?: string }).code === "EPERM";
  }
}

// A command that exits on its own may leave a process behind on purpose, which holds nothing.
const commandRuns = ({ group, signalled }: Holder): boolean =>
  running(signalled ? -group! : group!);

/**
 * Link fails when the name exists, so the filesystem decides the winner of a race, and the
 * contents are complete before the name appears. Creating the file and then writing it would
 * leave a window where it reads as empty, which the staleness checks would clear.
 */
function create(path: string, contents: string): boolean {
  const staging = `${path}.${process.pid}`;
  // Deliberately outside the catch: a path we cannot write is a broken lock, not a busy one, and
  // must abandon serialising instead of polling until the deadline.
  writeFileSync(staging, contents);
  try {
    linkSync(staging, path);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(staging, { force: true });
  }
}

const acquire = (): boolean =>
  create(LOCK, JSON.stringify({ pid: process.pid, startedAt: Date.now(), command }));

function dropIfStale(): void {
  const raw = readLock();
  if (raw === undefined) return;
  const holder = parseHolder(raw);
  // An unreadable lock is a half-written or corrupt one, and nobody can prove it is live. A live
  // holder is never reclaimed on age: a slow run under load outlasted any bound and a second check
  // ran beside it. A reused pid reads as live too, which ends in the wait timeout, not an overlap.
  if (holder && (running(holder.pid) || (holder.group && commandRuns(holder)))) return;
  // Deleting by name after the read deleted a fresh lock another waiter wrote in between. A claim,
  // named for these exact contents, lets one waiter delete them, and while they sit at the lock path
  // no acquire can replace them, so the re-read under the claim stays true until the delete.
  // A waiter that dies holding a claim must not block the rest, yet clearing a dead claim by name
  // repeated the race one level down: two waiters saw the same dead claim, and the slower deleted
  // the fresh claim the faster had just written. So no claim is deleted while these contents stand:
  // claims are numbered, a dead one is passed over to the next number, and a live one ends the try.
  const base = `${LOCK}.reclaim-${createHash("sha1").update(raw).digest("hex")}`;
  let slot = 0;
  while (!create(`${base}.${slot}`, String(process.pid))) {
    let owner: number;
    try {
      owner = Number.parseInt(readFileSync(`${base}.${slot}`, "utf8"), 10);
    } catch {
      return; // cleared by the waiter that reclaimed these contents: the next poll reads afresh
    }
    // create() writes the pid before the name appears, so a claim without one is no live waiter's.
    if (Number.isInteger(owner) && running(owner)) return;
    slot++;
  }
  try {
    if (readLock() === raw) rmSync(LOCK, { force: true });
  } finally {
    // These contents are gone from the lock path for good (each lock carries its pid and start), so
    // no re-read under any of these claims can match again, and deleting them reopens nothing.
    for (let k = slot; k >= 0; k--) rmSync(`${base}.${k}`, { force: true });
  }
}

// Waiters take the lock in the order they came: each holds a ticket named for its arrival, and
// only the first live one may take it, so a waiter polling at the right moment no longer overtakes
// one that has waited longer. A dead waiter's ticket is passed over, never deleted by another. A
// lock free for three polls goes to any waiter: the first live ticket's process may wait for
// nothing, its pid reused or its waiter stopped.
const QUEUE = `${LOCK}.queue`;
let ticket: string | undefined;
// process.exit skips a finally, so each exit while waiting hands the ticket back itself.
const leave = () => ticket && rmSync(`${QUEUE}/${ticket}`, { force: true });
function first(): boolean {
  const live = readdirSync(QUEUE)
    .filter((name) => running(Number(name.split("-")[1])))
    .sort();
  return live[0] === ticket;
}

async function waitForLock(): Promise<boolean> {
  mkdirSync(QUEUE, { recursive: true });
  ticket = `${String(Date.now()).padStart(15, "0")}-${process.pid}`;
  writeFileSync(`${QUEUE}/${ticket}`, "");
  try {
    return await queueForLock();
  } finally {
    leave();
  }
}

async function queueForLock(): Promise<boolean> {
  let started = Date.now();
  let spokeAt = 0;
  // By inode: each lock is a new file, and a second read of a lock path a test made a FIFO would
  // take the contents meant for the staleness check.
  const inode = () => {
    try {
      return statSync(LOCK).ino;
    } catch {
      return undefined;
    }
  };
  let holder = inode();
  let freeSince: number | undefined;
  for (;;) {
    const free = holder === undefined && freeSince !== undefined;
    if (first() || (free && Date.now() - freeSince! > 3 * POLL_MS)) {
      if (acquire()) return true;
      dropIfStale();
      if (acquire()) return true;
    }
    const now = inode();
    if (now !== holder) [holder, started, spokeAt] = [now, Date.now(), 0];
    freeSince = now === undefined ? (freeSince ?? Date.now()) : undefined;

    const waited = Date.now() - started;
    // At least: a first poll in the millisecond the wait began measures 0, and a wait of 0 slept.
    // A shorter wait gives up on another command only. One held by this same command, such as the
    // two installs a session's start begins at once, is waited for in full, since that run leaves
    // this one little to do; a free lock for one poll, in which such a run may take it first.
    const givesUp = () => {
      const current = readHolder();
      return current === undefined
        ? waited >= POLL_MS
        : current.command?.join("\0") !== command.join("\0");
    };
    if (waited >= Math.max(WAIT_MS, FULL_WAIT_MS) || (waited >= WAIT_MS && givesUp())) {
      console.error(
        `[check-lock] ${holderName()} still holds ${LOCK} after ${Math.round(waited / 1000)}s; not running "${command.join(" ")}" beside it. Retry once it finishes.`,
      );
      leave();
      process.exit(1);
    }
    if (waited - spokeAt >= SPEAK_MS) {
      spokeAt = waited;
      console.warn(
        `[check-lock] waiting ${Math.round(waited / 1000)}s for ${holderName()} to finish`,
      );
    }
    await sleep(POLL_MS);
  }
}

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: check-lock <command> [args...]");
  process.exit(2);
}

// A signal's default action killed a waiter inside dropIfStale and left its claim for good once
// the stale lock was gone, and once the command runs it ended check-lock alone, so a build ran on
// beside a lock whose dead holder read as stale. One handler serves both phases, leaving no gap:
// while waiting it defers the signal to the event loop, after the claim's finally has removed it;
// while running it passes the signal to the command, and a second one kills it.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
let child: ChildProcess | undefined = undefined;
let received: NodeJS.Signals | undefined;
function onSignal(signal: NodeJS.Signals): void {
  if (!child) {
    leave();
    process.exit(128 + constants.signals[signal]);
  }
  try {
    process.kill(-child.pid!, received ? "SIGKILL" : signal);
  } catch {
    /* the group is already gone */
  }
  if (!received) annotate({ signalled: true });
  received ??= signal;
}
for (const signal of SIGNALS) process.on(signal, onSignal);
let held = false;
try {
  if (process.env.SCAFFOLDING_LOCKED !== LOCK) held = await waitForLock();
} catch (error) {
  console.warn(
    `[check-lock] lock unusable (${String(error)}); running "${command.join(" ")}" unserialised`,
  );
}

/** Rewrites this run's lock with `fields`, whole through a rename, as create() writes it. */
function annotate(fields: Partial<Holder>): void {
  const holder = held ? readHolder() : undefined;
  if (holder?.pid !== process.pid) return;
  try {
    writeFileSync(`${LOCK}.${process.pid}`, JSON.stringify({ ...holder, ...fields }));
    renameSync(`${LOCK}.${process.pid}`, LOCK);
  } catch {
    /* the lock keeps what it names, which covers every case but a kill of the caller's group */
  } finally {
    rmSync(`${LOCK}.${process.pid}`, { force: true });
  }
}

function release(): void {
  if (!held) return;
  try {
    if (readHolder()?.pid === process.pid) rmSync(LOCK, { force: true });
  } catch {
    /* a lock we cannot remove is reclaimed by the next run once this pid is gone */
  }
}

// Passing the signal to the command alone was not enough: `sh -c 'cd catalog && astro build'` died
// and left the build running. So the command runs in its own process group (detached, which also
// gives up the terminal: opening /dev/tty fails), the handler signals that group, and after a
// signal the lock is released once the group is empty.
const spawned = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env: { ...process.env, SCAFFOLDING_LOCKED: LOCK },
  detached: true,
});
child = spawned;
// The command's own group escapes a SIGKILL to the caller's group, so the lock names the command
// too, and a waiter reads it as live until the command has exited.
if (spawned.pid) annotate({ group: spawned.pid });
const result = await new Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}>((done) => {
  spawned.on("error", (error) => done({ status: null, signal: null, error }));
  spawned.on("exit", (status, signal) => done({ status, signal }));
});
// A command killed by a signal sent to it alone, not to check-lock, left its steps running in its
// group while the lock was released; so the rest of the group gets the same signal. Only after a
// signal: a command that exits on its own may leave a process behind on purpose.
if (result.signal && !received) {
  annotate({ signalled: true });
  try {
    process.kill(-spawned.pid!, result.signal);
  } catch {
    /* the group is already gone */
  }
}
const stoppedAt = Date.now();
while ((received || result.signal) && running(-spawned.pid!)) {
  // After a signal the command took alone, nobody sends the second one that kills: 10 s do.
  if (!received && Date.now() - stoppedAt > 10_000)
    try {
      process.kill(-spawned.pid!, "SIGKILL");
    } catch {
      /* the group is already gone */
    }
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
if (received) {
  process.removeAllListeners(received);
  process.kill(process.pid, received);
}
// A signalled child reports a null status, and exiting 0 there would hide a killed gate.
process.exit(result.status ?? 1);
