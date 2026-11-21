import { ESLint } from "eslint";
import { expect, test } from "vitest";
import config from "../config/eslint.js";

const rule = "scaffolding/no-inherited-lookup";
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: config,
  ruleFilter: ({ ruleId }) => ruleId === rule,
});

async function findings(code: string) {
  const [result] = await eslint.lintText(code, { filePath: "test/prototype-lookup.fixture.ts" });
  expect(result.fatalErrorCount).toBe(0);
  expect(result.messages.map((item) => item.ruleId)).toEqual(result.messages.map(() => rule));
  return result.messages.map((item) => item.messageId);
}

test("rejects reads, membership and construction from the historical table defects", async () => {
  expect(
    await findings(`
export declare const STALE_DAYS_BY_STAGE: Record<string, number | null>;
export const staleLimit = (stage: string | undefined) => stage ? STALE_DAYS_BY_STAGE[stage] : 7;

export const toDataset = (data: Record<string, unknown>) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    out[k.replace(/^data-/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = String(v);
  }
  return out;
};

declare const SECTION_STYLES: Record<"basic" | "featured", string>;
export function getSectionStyle(theme?: "basic" | "featured") {
  if (!theme || !(theme in SECTION_STYLES)) return "";
  return SECTION_STYLES[theme];
}

export const fill = (text: string, values: object = {}) =>
  text.replace(/\\{(\\w+)\\}/g, (_, key: string) =>
    String((values as Record<string, unknown>)[key] ?? ""),
  );

export function recognized(counts: Record<string, number>, item: { kind: string }) {
  if (counts[item.kind] !== undefined) counts[item.kind] += 1;
}
`),
  ).toEqual(["read", "write", "membership", "read", "read", "read"]);
});

test("accepts own-key guards, safe construction, collections and closed indexes", async () => {
  expect(
    await findings(`
declare const table: Record<string, string>;
declare const key: string;
declare const closed: "a" | "b";
declare const array: readonly string[];
declare const tuple: readonly [string, number];
declare const map: Map<string, string>;
declare const set: Set<string>;
declare const index: number;

Object.hasOwn(table, key) && table[key];
!Object.hasOwn(table, key) || table[key];
Object.hasOwn(table, key) ? table[key] : "";
function fill(table: Record<string, string>, key: string) {
  if (!Object.hasOwn(table, key)) return "";
  return table[key];
}
export function facet(table: Record<string, string>, key: string) {
  for (;;) {
    if (!Object.hasOwn(table, key)) continue;
    table[key] += "!";
  }
}
for (const field of Object.keys(table)) table[field];
Object.keys(table).filter((field) => table[field]);
const nullTable: Record<string, string> = Object.create(null);
nullTable[key] = "";
key in nullTable;
nullTable[key];
const withProtoRemoved: Record<string, string> = {};
Object.setPrototypeOf(withProtoRemoved, null);
withProtoRemoved[key] = "";
export const fromEntries = Object.fromEntries([[key, "value"]]);
const object = { a: 1, b: 2 };
object[closed];
table["constructor"];
table[\`constructor\`];
table[\`prefix-\${key}\`];
array[index];
tuple[index];
map.get(key);
set.has(key);
"abc".replace(/[abc]/g, (letter) => table[letter]);
"abc".replace(/&(a|b);/g, (_match, letter: string) => table[letter]);
const paths = [..."".matchAll(/<loc>(\\/[^<]*)<\\/loc>/g)].map((match) => match[1]);
for (const path of paths) table[path];
delete table[key];
`),
  ).toEqual([]);
});

test("guard ownership is specific to the table, key and branch", async () => {
  expect(
    await findings(`
declare const table: Record<string, string>;
declare const other: Record<string, string>;
declare const key: string;
declare const field: string;
Object.hasOwn(other, key) && table[key];
Object.hasOwn(table, field) && table[key];
Object.hasOwn(table, key) || table[key];
Object.keys(other).filter((field) => table[field]);
const built = Object.fromEntries([[field, "value"]]);
built[key];
const populated: Record<string, string> = {};
populated[key] = "value";
for (const [name] of Object.entries(populated)) table[name];
export function shadowed(Object: { hasOwn: (target: object, key: string) => boolean }) {
  return Object.hasOwn(table, key) && table[key];
}
`),
  ).toEqual(["read", "read", "read", "read", "read", "write", "read", "read"]);
});
