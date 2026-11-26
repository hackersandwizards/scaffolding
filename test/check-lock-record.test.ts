import { failParsingInput } from "./json-parse-fault.ts";
import { readHolder as readHookHolder } from "../.githooks/check-lock-record.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  acquireCheckLock,
  CheckLockDeadline,
  dropIfStale,
  holderName,
  inspectCheckLock,
  readHolder,
  running,
  type Holder,
} from "../template/.githooks/check-lock-record.ts";
import { testDirectory } from "./test-directory.ts";

test.each([{ command: ["echo", "two words"], expected: ["pid", "startedAt", "command"] }])(
  "writes holder fields in their original order",
  ({ command, expected }) => {
    using fixture = testDirectory();
    const lock = join(fixture.folder, "check.lock");
    acquireCheckLock(lock, command);
    const raw = readFileSync(lock, "utf8");
    expect([...raw.matchAll(/"([^"]+)":/g)].map((match) => match[1])).toEqual(expected);
  },
);

test.each([{ raw: "an invalid lock", expected: true }])(
  "keeps an invalid lock after a malformed claim when the next claimant is live",
  ({ raw, expected }) => {
    using fixture = testDirectory();
    const lock = join(fixture.folder, "check.lock");
    writeFileSync(lock, raw);
    const digest = createHash("sha1").update(raw).digest("hex");
    writeFileSync(`${lock}.reclaim-${digest}.0`, "not a pid");
    writeFileSync(`${lock}.reclaim-${digest}.1`, String(process.pid));
    dropIfStale(lock);
    expect(existsSync(lock)).toBe(expected);
  },
);

test.each([{ folderName: "check.lock", expected: false }])(
  "recognises a directory as an occupied unreclaimable lock",
  ({ folderName, expected }) => {
    using fixture = testDirectory();
    const lock = join(fixture.folder, folderName);
    mkdirSync(lock);
    const snapshot = inspectCheckLock(lock);
    expect(snapshot.id).toBe(`inode ${statSync(lock).ino}`);
    expect(snapshot.stale).toBe(expected);
  },
);

test.each([{ waited: 5999, expected: false }])(
  "gives the first waiter three polls to reclaim a stale lock",
  ({ waited, expected }) => {
    const snapshot = { id: "inode 1", read: undefined, stale: true };
    expect(new CheckLockDeadline(0, 900_000).expired(snapshot, waited, ["sh"])).toBe(expected);
  },
);

test.each([{ command: "echo", expected: TypeError }])(
  "throws when a parsed holder names its command as a string",
  ({ command, expected }) => {
    const read = { pid: process.pid, startedAt: 1, command } as unknown as Holder;
    const snapshot = { id: "live", read, stale: false };
    expect(() => new CheckLockDeadline(0, 900_000).expired(snapshot, 1, ["echo"])).toThrow(
      expected,
    );
  },
);

test.each([{ raw: '{"pid":10,"startedAt":2,"group":1}', expected: { pid: 10, startedAt: 2 } }])(
  "does not keep process group one in a holder record",
  ({ raw, expected }) => {
    using fixture = testDirectory();
    const lock = join(fixture.folder, "check.lock");
    writeFileSync(lock, raw);
    expect(readHolder(lock)).toEqual(expected);
  },
);

test.each([{ pid: 17, group: 24, expected: "command 24 of dead pid 17" }])(
  "names a surviving group when the owner PID is dead",
  ({ pid, group, expected }) => {
    using kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("process unavailable"), { code: "ESRCH" });
    });
    expect(holderName({ pid, startedAt: 2, group })).toBe(expected);
    expect(kill).toHaveBeenCalledWith(pid, 0);
  },
);

test.each([{ code: "EPERM", expected: true }])(
  "counts another user's process as live",
  ({ code, expected }) => {
    using kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code });
    });
    expect(running(17)).toBe(expected);
    expect(kill).toHaveBeenCalledWith(17, 0);
  },
);

test.each([
  ["hook", readHookHolder],
  ["template", readHolder],
] as const)("the %s holder parser propagates unexpected parser failures", (_copy, read) => {
  using fixture = testDirectory();
  const path = join(fixture.folder, "check.lock");
  const value = '{"pid":109,"startedAt":2}';
  writeFileSync(path, value);
  const failure = new RangeError("holder parser failed");
  using _parse = failParsingInput(value, failure);
  expect(() => read(path)).toThrow(failure);
});
