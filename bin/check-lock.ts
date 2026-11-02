#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";

// Concurrent `bun run check` runs in one checkout corrupt each other: vitest workers spawn `bun`
// subprocesses whose module resolution reads files a parallel run is rewriting, and the spawned
// script dies part-way through its output. Serialising the runs removes the overlap. A broken lock
// falls through to running the checks, since it must never be the thing that stops work. A live
// holder past the wait fails instead: running beside it is the corruption this lock exists to stop.

// `bun run check` starts this from the repository root, whichever repository it is.
const LOCK = process.env.CHECK_LOCK ?? resolve("node_modules", ".check.lock");

// Worst case is every concurrent session's check back to back. Four sessions never approach this.
// Overridable so the test can prove the timeout without waiting it out.
const WAIT_MS = Number(process.env.CHECK_LOCK_WAIT_MS ?? 15 * 60 * 1000);
// NaN would never compare greater, and the wait would never end.
if (!Number.isFinite(WAIT_MS)) throw new Error("CHECK_LOCK_WAIT_MS must be a number of ms");
const POLL_MS = 2_000;
const SPEAK_MS = 30_000;

interface Holder {
  pid: number;
  startedAt: number;
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
    return typeof holder.pid === "number" ? holder : undefined;
  } catch {
    return undefined;
  }
}

const readHolder = (): Holder | undefined => parseHolder(readLock());

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
  create(LOCK, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

function dropIfStale(): void {
  const raw = readLock();
  if (raw === undefined) return;
  const holder = parseHolder(raw);
  // An unreadable lock is a half-written or corrupt one, and nobody can prove it is live. A live
  // holder is never reclaimed on age: a slow run under load outlasted any bound and a second check
  // ran beside it. A reused pid reads as live too, which ends in the wait timeout, not an overlap.
  if (holder && running(holder.pid)) return;
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
    // A reused pid reads as live, which ends in the wait timeout, not an overlap.
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

async function waitForLock(): Promise<boolean> {
  const started = Date.now();
  let spokeAt = 0;
  for (;;) {
    if (acquire()) return true;
    dropIfStale();
    if (acquire()) return true;

    const waited = Date.now() - started;
    if (waited > WAIT_MS) {
      console.error(
        `[check-lock] pid ${readHolder()?.pid ?? "unknown"} still holds ${LOCK} after ${Math.round(waited / 1000)}s; not running "${command.join(" ")}" beside it. Retry once it finishes.`,
      );
      process.exit(1);
    }
    if (waited - spokeAt >= SPEAK_MS) {
      spokeAt = waited;
      console.warn(
        `[check-lock] waiting ${Math.round(waited / 1000)}s for pid ${readHolder()?.pid ?? "unknown"} to finish`,
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
// the stale lock was gone. A handler defers the signal to the event loop, after the claim's
// finally has removed it. Only for the wait: the run itself keeps the default actions.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const stop = (signal: NodeJS.Signals): never => process.exit(128 + constants.signals[signal]);
for (const signal of SIGNALS) process.on(signal, stop);
let held = false;
try {
  held = await waitForLock();
} catch (error) {
  console.warn(
    `[check-lock] lock unusable (${String(error)}); running "${command.join(" ")}" unserialised`,
  );
}
for (const signal of SIGNALS) process.off(signal, stop);

function release(): void {
  if (!held) return;
  try {
    if (readHolder()?.pid === process.pid) rmSync(LOCK, { force: true });
  } catch {
    /* a lock we cannot remove is reclaimed by the next run once this pid is gone */
  }
}

const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
release();
if (result.status !== 0) {
  const cause = result.signal ? `killed by ${result.signal}` : `exit ${result.status}`;
  console.log(
    `[check-lock] ${command.join(" ")} failed (${cause}). The failing step and its reason are on stderr.`,
  );
}
// A signalled child reports a null status, and exiting 0 there would hide a killed gate.
process.exit(result.status ?? 1);
