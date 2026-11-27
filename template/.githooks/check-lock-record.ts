// A skeleton file of @hackersandwizards/scaffolding at the version package.json pins: check-structure
// --fix writes it, and the gate fails a copy that differs unless `skip.structure` is set.

import { createHash } from "node:crypto";
import { linkSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

export interface Holder {
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

function readLock(lockFile: string, forReclaim = false): string | undefined {
  try {
    return readFileSync(lockFile, "utf8");
  } catch (error) {
    // A directory or an unreadable holder must still go through the wait deadline.
    if (forReclaim || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const validCheckLockCommand = (command: unknown): boolean =>
  Array.isArray(command) && command.every((arg) => typeof arg === "string");

function parseHolder(raw: string | undefined): Holder | undefined {
  if (raw === undefined) return undefined;
  let holder: Holder | null;
  try {
    holder = JSON.parse(raw) as Holder | null;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (typeof holder?.pid !== "number") return undefined;
  // kill(-1) and kill(0) address every process or this one's group, never the command's.
  if (holder.group === undefined || !Number.isInteger(holder.group) || holder.group <= 1)
    delete holder.group;
  if (!validCheckLockCommand(holder.command)) delete holder.command;
  return holder;
}

export const readHolder = (lockFile: string): Holder | undefined => parseHolder(readLock(lockFile));
export const holderName = (holder: Holder | undefined): string => {
  if (!holder) return "pid unknown";
  return holder.group && !running(holder.pid)
    ? `command ${holder.group} of dead pid ${holder.pid}`
    : `pid ${holder.pid}`;
};

export function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive, under another user.
    return (error as { code?: string }).code === "EPERM";
  }
}

// A command that exits on its own may leave a process behind on purpose, which holds nothing.
const commandRuns = (group: number, signalled: true | undefined): boolean =>
  running(signalled ? -group : group);
const live = (holder: Holder): boolean =>
  running(holder.pid) ||
  (holder.group !== undefined && commandRuns(holder.group, holder.signalled));
// An unreadable lock is a half-written or corrupt one, and nobody can prove it is live. A live
// holder is never reclaimed on age: a slow run under load outlasted any bound and a second check
// ran beside it. A reused pid reads as live too, which ends in the wait timeout, not an overlap.
const stale = (raw: string | undefined, holder: Holder | undefined): raw is string =>
  raw !== undefined && !(holder && live(holder));

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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(staging, { force: true });
  }
}

export const acquireCheckLock = (lockFile: string, command: string[]): boolean =>
  create(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), command }));

export function dropIfStale(lockFile: string): void {
  const raw = readLock(lockFile, true);
  if (!stale(raw, parseHolder(raw))) return;
  // Deleting by name after the read deleted a fresh lock another waiter wrote in between. A claim,
  // named for these exact contents, lets one waiter delete them, and while they sit at the lock path
  // no acquire can replace them, so the re-read under the claim stays true until the delete.
  // A waiter that dies holding a claim must not block the rest, yet clearing a dead claim by name
  // repeated the race one level down: two waiters saw the same dead claim, and the slower deleted
  // the fresh claim the faster had just written. So no claim is deleted while these contents stand:
  // claims are numbered, a dead one is passed over to the next number, and a live one ends the try.
  const base = `${lockFile}.reclaim-${createHash("sha1").update(raw).digest("hex")}`;
  let slot = 0;
  while (!create(`${base}.${slot}`, String(process.pid))) {
    let owner: number;
    try {
      owner = Number.parseInt(readFileSync(`${base}.${slot}`, "utf8"), 10);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // create() writes the pid before the name appears, so a claim without one is no live waiter's.
    if (Number.isInteger(owner) && running(owner)) return;
    slot++;
  }
  try {
    if (readLock(lockFile, true) === raw) rmSync(lockFile, { force: true });
  } finally {
    // These contents are gone from the lock path for good (each lock carries its pid and start), so
    // no re-read under any of these claims can match again, and deleting them reopens nothing.
    for (let k = slot; k >= 0; k--) rmSync(`${base}.${k}`, { force: true });
  }
}

// By pid and start, which a holder rewriting its own lock keeps; by inode where the lock is no
// plain file or unreadable, since a read of a lock path a test made a FIFO would take the contents
// meant for the staleness check. One read per poll serves the wait too: a second read let a
// holder of this command release in between and read as another command.
export function inspectCheckLock(lockFile: string) {
  const free = { id: undefined, read: undefined, stale: false };
  let stat;
  try {
    stat = statSync(lockFile);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return free;
    throw error;
  }
  let raw: string | undefined;
  try {
    if (stat.isFile()) raw = readFileSync(lockFile, "utf8");
  } catch (error) {
    // Released between the two reads: free, not a path no waiter can reclaim.
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT") return free;
  }
  const read = parseHolder(raw);
  return {
    id: read ? `${read.pid} ${read.startedAt}` : `inode ${stat.ino}`,
    read,
    // What dropIfStale removes: the first waiter reclaims it within a poll.
    stale: stale(raw, read),
  };
}

export const LOCK_POLL_MS = 2_000;
export const LOCK_TICKET_MS = 3 * LOCK_POLL_MS;

export class CheckLockDeadline {
  private readonly waitMs: number;
  private readonly fullWaitMs: number;

  constructor(waitMs: number, fullWaitMs: number) {
    this.waitMs = waitMs;
    this.fullWaitMs = fullWaitMs;
  }

  expired(
    snapshot: ReturnType<typeof inspectCheckLock>,
    waited: number,
    command: string[],
  ): boolean {
    // A shorter wait gives up on another command only. One held by this same command, such as the
    // two installs a session's start begins at once, is waited for in full, since that run leaves
    // this one little to do. So is a free lock, no file at its path, which only a waiter ahead in
    // the queue leaves free (live, or renewed within LOCK_TICKET_MS): four installs at once gave up when
    // it was free at two polls in a row. So is a stale lock, a dead holder's or one that does not
    // parse, for as long as the queue gives the waiter ahead to reclaim it; a live waiter's claim
    // can keep it from that. A path no waiter can reclaim, such as a folder or a file it cannot
    // read, is given up on.
    const givesUp =
      snapshot.id !== undefined &&
      (!snapshot.stale || waited >= LOCK_TICKET_MS) &&
      snapshot.read?.command?.join("\0") !== command.join("\0");
    return waited >= Math.max(this.waitMs, this.fullWaitMs) || (waited >= this.waitMs && givesUp);
  }
}
