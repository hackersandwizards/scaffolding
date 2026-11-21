import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ESLint } from "eslint";
import { beforeAll, expect, test } from "vitest";
import astro from "../config/eslint-astro.js";
import base from "../config/eslint.js";
import { ownEntry } from "../lib/own-entry.ts";

const rule = "scaffolding/no-inherited-lookup";
const root = realpathSync(mkdtempSync(join(tmpdir(), "scaffolding-lookup-")));
const lintOptions = {
  cwd: root,
  overrideConfigFile: true,
  ruleFilter: ({ ruleId }: { ruleId: string }) => ruleId === rule,
} as const;
const jsLint = new ESLint({ ...lintOptions, overrideConfig: base });
const astroLint = new ESLint({ ...lintOptions, overrideConfig: astro });

beforeAll(() => {
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        allowJs: true,
        checkJs: true,
        jsx: "preserve",
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      include: ["src/**/*"],
    }),
  );
  writeFileSync(
    join(root, "src/tables.ts"),
    `
    export const closed = { a: 1, b: 2 };
    export const ownConstructor = { constructor: 3 };
    export const noPrototype: Record<string, number> = Object.create(null);
    export function factory(): Record<string, number> { return noPrototype; }
  `,
  );
});

async function lintFixture(file: string, code: string) {
  const lint = file.endsWith(".astro") ? astroLint : jsLint;
  writeFileSync(join(root, file), code);
  const [result] = await lint.lintFiles([file]);
  expect(result.fatalErrorCount, JSON.stringify(result.messages)).toBe(0);
  expect(result.messages.map((item) => item.ruleId)).toEqual(result.messages.map(() => rule));
  return result.messages;
}

test("reports the form and points to its repair", async () => {
  const messages = await lintFixture(
    "src/forms.ts",
    `import { closed } from "./tables";
declare const table: Record<string, number>;
declare const key: string;
declare const state: { byId: Record<string, number> };
table[key];
if (table[key]) console.log(key);
if (table[key] !== undefined) console.log(key);
key in closed;
(state.byId[key]) = 1;
class C {
  t: Record<string, number> = {};
  update(k: string) { this.t[k] = 1; this.t[k]++; }
}
const { [key]: value } = table;
let picked;
({ [key]: picked } = table);
closed[key];
typeof table[key] === "undefined";
const orElse = table[key] ?? 0;
if (key && table[key]) console.log(key);
export function param({ [key]: v }: Record<string, number>) { return v; }
`,
  );
  expect(messages.map(({ messageId, line }) => [messageId, line])).toEqual([
    ["read", 5],
    ["truthy", 6],
    ["definedness", 7],
    ["membership", 8],
    ["write", 9],
    ["write", 12],
    ["update", 12],
    ["destructure", 14],
    ["destructure", 16],
    ["read", 17],
    ["definedness", 18],
    ["definedness", 19],
    ["truthy", 20],
    ["destructure", 21],
  ]);
  expect(messages[0].message).toContain("ownEntry(table, key)");
  expect(messages[3].message).toContain("Object.hasOwn");
  expect(messages[4].message).toContain("Object.fromEntries");
  expect(messages[4].message).toContain("Object.defineProperty");
});

test("uses declared key types, including open alternatives and inherited names in finite unions", async () => {
  const messages = await lintFixture(
    "src/keys.ts",
    `import { closed, ownConstructor } from "./tables";
declare const table: Record<string, number>;
declare const key: string;
declare const finite: "a" | "b";
declare const inherited: "a" | "constructor";
declare const template: \`id-\${string}\`;
declare const union: "a" | \`id-\${string}\`;
declare const optional: { toString?: () => string };
declare const constrained: "a" | "toString";
closed[finite];
finite in closed;
closed[inherited];
inherited in closed;
ownConstructor[inherited];
optional[constrained];
table[template];
table[union];
if (key === "a" || key === "b") table[key];
table[key as keyof typeof closed];
export function raw(input: unknown) { return table[input as string]; }
export function generic<K extends string>(t: Record<K, number>, k: K) { return t[k]; }
const derived = "/fixed".slice(0);
table[derived];
Object.keys(table).map((k) => closed[k]);
`,
  );
  expect(messages.map(({ line }) => line)).toEqual([12, 13, 15, 16, 17, 19, 20, 21, 23, 24]);
});

test("accepts dominating own guards on the same values and within the same function", async () => {
  expect(
    await lintFixture(
      "src/guards.ts",
      `
declare const table: Record<string, number>;
declare const key: string;
declare const other: string;
declare const nested: Record<string, Record<string, number>>;
if (Object.hasOwn(table, key)) { table[key]; key in table; table[key] = 1; }
Object.hasOwn(table, key) && table[key];
!Object.hasOwn(table, key) || table[key];
Object.hasOwn(table, key) ? table[key] : 0;
Object.prototype.hasOwnProperty.call(table, key) && table[key];
if (Object.hasOwn(nested, key) && Object.hasOwn(nested[key]!, other))
  nested[key]![other];
class C {
  t: Record<string, number> = {};
  get(k: string) {
    if (!Object.hasOwn(this.t, k)) throw new Error();
    const offset = 1;
    return this.t[k] + offset;
  }
}
function read(t: Record<string, number>, k: string) {
  if (!Object.hasOwn(t, k)) return 0;
  console.log(k);
  return t[k];
}
for (const k in table) {
  if (!Object.hasOwn(table, k)) continue;
  table[k];
}
outer: for (const k in table) {
  if (!Object.hasOwn(table, k)) continue outer;
  table[k];
}
if (key.startsWith("prefix-")) table[key];
if (key !== "__proto__") table[key] = 0;
if (Object.keys(table).includes(key)) table[key];
const owns = Object.hasOwn(table, key);
owns && table[key];
function rejected(t: Record<string, number>, k: string) {
  if (!Object.hasOwn(t, k)) { t = {}; return 0; }
  return t[k];
}
`,
    ),
  ).toEqual([]);
});

test("rejects stale, mismatched, and non-dominating guards", async () => {
  const messages = await lintFixture(
    "src/stale.ts",
    `declare let table: Record<string, number>;
declare let key: string;
declare const other: string;
declare const state: { table: Record<string, number> };
Object.hasOwn(table, other) && table[key];
Object.hasOwn(table, key) || table[key];
if (Object.hasOwn(table, key)) { table = {}; table[key]; }
if (Object.hasOwn(table, key)) { key = other; table[key]; }
if (Object.hasOwn(state.table, key)) { state["table"] = {}; state.table[key]; }
if (Object.hasOwn(table, key)) { delete table[key]; table[key]; }
if (Object.hasOwn(table, key)) { [1].map(() => table[key]); }
for (const k in table) table[k];
function shadow(Object: { hasOwn(table: object, key: string): boolean }) {
  return Object.hasOwn(table, key) && table[key];
}
function stale(t: Record<string, number>, k: string) {
  if (!Object.hasOwn(t, k)) return;
  for (let i = 0; i < 2; i++) { t[k]; t = {}; }
}
`,
  );
  expect(messages.map(({ line }) => line)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 14, 18]);
});

test("accepts same-object enumeration and null prototypes across declarations", async () => {
  expect(
    await lintFixture(
      "src/ownership.ts",
      `
import { noPrototype, factory } from "./tables";
declare const table: Record<string, number>;
declare const key: string;
for (const k of Object.keys(table)) table[k];
for (const [k] of Object.entries(table)) table[k];
Object.entries(table).forEach(([k]) => table[k]);
Object.entries(table).forEach((entry) => table[entry[0]]);
table[Object.entries(table)[0][0]];
Object.keys(table).filter((k) => table[k]);
Object.keys(table).reduce((sum, k) => sum + table[k], 0);
const keys = Object.keys(table);
for (let i = 0; i < keys.length; i++) table[keys[i]];
const set = new Set(Object.keys(table));
[...set].map((k) => table[k]);
let local: Record<string, number> = Object.create(null);
local[key];
const protoLiteral = { __proto__: null, a: 1 };
key in protoLiteral;
class C {
  table: Record<string, number> = Object.create(null);
  read(k: string) { return this.table[k]; }
}
noPrototype[key] = 1;
key in factory();
const groups = Object.groupBy([1], String);
groups[key];
const removed: Record<string, number> = {};
Object.setPrototypeOf(removed, null);
removed[key] = 1;
const closure = () => removed[key];
const first = keys.filter(Boolean).sort()[0];
table[first];
`,
    ),
  ).toEqual([]);
});

test("does not infer ownership after mutating an enumeration or replacing a null table", async () => {
  const messages = await lintFixture(
    "src/changed.ts",
    `
declare const table: Record<string, number>;
declare const other: Record<string, number>;
declare const key: string;
let local: Record<string, number> = Object.create(null);
local = {};
local[key];
const keys = Object.keys(table);
keys.push(key);
for (const k of keys) table[k];
for (const k of Object.keys(other)) table[k];
for (let k of Object.keys(table)) { k = key; table[k]; }
`,
  );
  expect(messages.map(({ line }) => line)).toEqual([7, 10, 11, 12]);
});

test("leaves arrays, tuples, collections, instances, numbers and deletes outside the rule", async () => {
  expect(
    await lintFixture(
      "src/excluded.ts",
      `
declare const key: string;
declare const index: number;
declare const array: readonly number[];
declare const tuple: [string, number];
declare const map: ReadonlyMap<string, number>;
declare const set: Set<string>;
declare const record: Record<string, number>;
class Model { a = 0; }
array[key];
tuple[key];
map[key];
set[key];
new Model()[key];
record[index];
delete (record[key]);
`,
    ),
  ).toEqual([]);
});

test("type-checks TSX and JavaScript through the real preset", async () => {
  const tsx = await lintFixture(
    "src/card.tsx",
    `
import { closed } from "./tables";
export const Card = ({ k }: { k: string }) => <div>{closed[k]}</div>;
export const Safe = ({ k }: { k: string }) => <div>{Object.hasOwn(closed, k) && closed[k]}</div>;
`,
  );
  const js = await lintFixture(
    "src/example.js",
    `
const table = { a: 1 };
export const unsafe = (key) => table[key];
/** @param {"a"|"b"} key */
export const safe = (key) => key in table;
`,
  );
  expect(tsx.map(({ line, messageId }) => [line, messageId])).toEqual([[3, "read"]]);
  expect(js.map(({ line, messageId }) => [line, messageId])).toEqual([[3, "read"]]);
});

test("reports Astro frontmatter, template and client lookups at their original positions", async () => {
  const messages = await lintFixture(
    "src/Card.astro",
    `---
import { closed } from "./tables";
const key: string = Astro.url.pathname;
const title = closed[key];
---
<div>{closed[key]}{Object.hasOwn(closed, key) && closed[key]}</div>
<script>
  import { closed } from "./tables";
  const name: string = window.location.pathname;
  console.log(closed[name]);
  if (Object.hasOwn(closed, name)) console.log(closed[name]);
</script>
`,
  );
  expect(
    messages.toSorted((a, b) => a.line - b.line).map(({ line, column }) => [line, column]),
  ).toEqual([
    [4, 15],
    [6, 7],
    [10, 15],
  ]);
  const bare = await lintFixture("src/Bare.astro", `<div>{{ a: 1 }[Astro.url.pathname]}</div>\n`);
  expect(bare.map(({ line, messageId }) => [line, messageId])).toEqual([[1, "read"]]);
});

test("handles files outside the configured project and changing virtual file contents", async () => {
  const before = "const table = {}; const key: string = ''; export const value = table[key];";
  const after = "const table = {}; const key: 'a' = 'a'; export const value = table[key];";
  expect((await lintFixture("excluded.ts", before)).map(({ messageId }) => messageId)).toEqual([
    "read",
  ]);
  expect(
    (await lintFixture("excluded-second.ts", before)).map(({ messageId }) => messageId),
  ).toEqual(["read"]);
  const [changed] = await jsLint.lintText(after, { filePath: "excluded.ts" });
  expect(changed.messages).toEqual([]);
});

test("ownEntry reads only own values and preserves falsy values", () => {
  expect(ownEntry({ ok: 0 }, "ok")).toBe(0);
  expect(ownEntry({}, "constructor")).toBeUndefined();
  expect(ownEntry({ constructor: 1 }, "constructor")).toBe(1);
  expect(ownEntry(undefined, "constructor")).toBeUndefined();
});
