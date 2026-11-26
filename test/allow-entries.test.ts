import { expect, test } from "vitest";
import {
  allowText,
  CheckAllowEntries,
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
    expect(() => new CheckAllowEntries(input, "demo")).toThrow(expected);
  },
);

test.each([[{ check: "demo", path: "example.md", reason: "fixture" }, []]])(
  "keeps an unseen exception when the scan is partial",
  (entry, expected) => {
    expect(new CheckAllowEntries({ scaffolding: { allow: [entry] } }, "demo").apply([])).toEqual(
      expected,
    );
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
