import { expect, test } from "vitest";
import {
  allowEntryProblem,
  allowText,
  applyAllow,
  auditAllow,
  type AllowEntry,
  formatAllowFinding,
  unmatchedAllowItems,
} from "../lib/allow-entries.ts";
import type { Package } from "../lib/repo.ts";

test.each([[Object("note") as unknown, false]])(
  "rejects boxed strings in allow entries",
  (input, expected) => {
    expect(allowText(input)).toBe(expected);
  },
);

test.each([
  [
    {
      check: "demo",
      path: ["file names", "used.md", "old.md"],
      text: ["name", "obsolete"],
      reason: "fixture",
    },
    [
      '{"check":"demo","path":"old.md","text":["name","obsolete"],"reason":"fixture"}',
      '{"check":"demo","path":["file names","used.md","old.md"],"text":"obsolete","reason":"fixture"}',
    ],
  ],
])(
  "yields stale path entries before stale text entries in original key order",
  (entry, expected) => {
    const findings = [
      { check: "demo", path: "used.md", text: "name", message: "fixture", name: true },
    ] as const;
    expect(
      [...unmatchedAllowItems(entry, [...findings])].map((item) => JSON.stringify(item)),
    ).toEqual(expected);
  },
);

test.each([[{ scaffolding: { allow: [null] } } as unknown as Package, "null"]])(
  "throws for a null allow entry before checking any findings",
  (input, expected) => {
    expect(() => auditAllow(input, "demo", [])).toThrow(expected);
  },
);

test.each([[{ check: "demo", path: "example.md", reason: "fixture" }, []]])(
  "keeps an unseen exception when the scan is partial",
  (entry, expected) => {
    expect(applyAllow({ scaffolding: { allow: [entry] } }, "demo", [])).toEqual(expected);
  },
);

test.each([
  [
    { reason: "fixture", check: "rule" },
    String.raw`{"check":"rule","path":"package.json","text":"{\"reason\":\"fixture\",\"check\":\"rule\"}","message":"missing"}`,
  ],
])("preserves the field order in allow-entry diagnostics", (entry, expected) => {
  expect(JSON.stringify(formatAllowFinding("rule", entry, "missing"))).toBe(expected);
});

test.each([[{ check: "demo", path: 5 }, "allow entry's path and text are strings"]])(
  "reports malformed path before a missing reason",
  (input, expected) => {
    const entry = input as unknown as AllowEntry;
    expect(allowEntryProblem("demo", entry, [])?.message).toContain(expected);
  },
);

test.each([[{ check: "demo", path: "used.md" }, "package.json"]])(
  "covers the original finding even when the partial scan reports a missing reason",
  (entry, expected) => {
    const findings = [{ check: "demo", path: "used.md", text: "", message: "original" }];
    const result = applyAllow({ scaffolding: { allow: [entry] } }, "demo", findings);
    expect(result.map(({ path }) => path)).toEqual([expected]);
  },
);

test.each([
  [
    [
      { check: "demo", path: "vanished.md", reason: "fixture" },
      { check: "demo", path: "kept.md" },
      { check: "demo", path: 5, reason: "fixture" },
    ],
    [
      '{"check":"demo","path":"vanished.md","reason":"fixture"}',
      '{"check":"demo","path":"kept.md"}',
      '{"check":"demo","path":5,"reason":"fixture"}',
    ],
  ],
])("reports stale, reasonless and malformed entries in package order", (entries, expected) => {
  const result = auditAllow(
    { scaffolding: { allow: entries as unknown as AllowEntry[] } },
    "demo",
    [],
  );
  expect(result.map(({ text }) => text)).toEqual(expected);
});
