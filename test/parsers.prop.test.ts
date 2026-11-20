import { fc, test, unicodeString } from "@hackersandwizards/scaffolding/property";
import { expect, vi } from "vitest";
import { jsonObject, isStrings } from "../lib/json.ts";
import { licenceAllowed } from "../lib/licence-expression.ts";
import { exported, targeted } from "../lib/package-exports.ts";
import {
  applyAllow,
  commentSyntax,
  exportTargets,
  fetchWaitS,
  ourRepository,
  styled,
} from "../lib/repo.ts";

const word = fc.stringMatching(/^[a-z]{1,10}$/);
const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/);

test.prop([fc.integer({ min: 1, max: 10_000_000 }), fc.nat(12)])(
  "the fetch timeout reads a positive decimal and caps it at the timer limit",
  (seconds, zeros) => {
    vi.stubEnv("SCAFFOLDING_FETCH_WAIT_S", `${"0".repeat(zeros)}${seconds}`);
    try {
      expect(fetchWaitS()).toBe(Math.min(seconds, Math.floor(2_147_483_647 / 1000)));
      vi.stubEnv("SCAFFOLDING_FETCH_WAIT_S", `-${seconds}`);
      expect(fetchWaitS()).toBe(20);
      vi.stubEnv("SCAFFOLDING_FETCH_WAIT_S", `${seconds}e+${zeros}`);
      expect(fetchWaitS()).toBe(20);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test.prop([fc.array(word), word, fc.constantFrom(["ts", "//"], ["yml", "#"], ["sh", "#"])])(
  "stripping a line comment preserves all preceding quoted tokens",
  (words, note, [extension, marker]) => {
    const content = words.map((word) => `"${marker}${word}" '${marker}${word}'`).join(" ");
    const code = `command ${content} `;
    expect(`${code}${marker} ${note}`.replace(commentSyntax(`file.${extension}`), "$1")).toBe(code);
  },
);

test.prop([
  fc.dictionary(
    fc.oneof(unicodeString, fc.constantFrom("__proto__", "constructor", "toString")),
    fc.jsonValue(),
  ),
])("JSON objects round trip from text and buffers", (value) => {
  const json = JSON.stringify(value);
  const expected: unknown = JSON.parse(json);
  expect(jsonObject(json)).toEqual(expected);
  expect(jsonObject(Buffer.from(json))).toEqual(expected);
});

test.prop([
  fc.oneof(fc.array(fc.jsonValue()), fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
])("non-object JSON cannot pass as an object", (value) => {
  expect(() => jsonObject(JSON.stringify(value))).toThrow("the JSON holds no object");
});

test.prop([fc.array(unicodeString), fc.integer()])(
  "string lists reject a non-string anywhere",
  (strings, number) => {
    expect(isStrings(strings)).toBe(true);
    expect(isStrings([...strings, number, ...strings])).toBe(false);
  },
);

const leaf = fc.constantFrom(
  { source: "MIT", allowed: true },
  { source: "Apache-2.0", allowed: true },
  { source: "MIT WITH Classpath-exception-2.0", allowed: true },
  { source: "GPL-3.0-only WITH Classpath-exception-2.0", allowed: false },
  { source: "GPL-3.0-only", allowed: false },
  { source: "Unknown", allowed: false },
);
type Expression = { source: string; allowed: boolean; precedence: number };
const licence = fc.letrec<{ expression: Expression }>((tie) => ({
  expression: fc.oneof(
    { depthSize: "small" },
    leaf.map((value) => ({ ...value, precedence: 3 })),
    fc
      .tuple(tie("expression"), fc.constantFrom("AND", "OR"), tie("expression"), fc.boolean())
      .map(([left, operator, right, group]) => {
        const precedence = operator === "AND" ? 2 : 1;
        const child = ({ source, precedence: rank }: Expression) =>
          rank < precedence ? `(${source})` : source;
        const source = `${child(left)} ${operator} ${child(right)}`;
        return {
          source: group ? `(${source})` : source,
          allowed:
            operator === "AND" ? left.allowed && right.allowed : left.allowed || right.allowed,
          precedence: group ? 3 : precedence,
        };
      }),
  ),
})).expression;

test.prop([licence], {
  examples: [
    [{ source: "MIT OR MIT AND GPL-3.0-only", allowed: true, precedence: 1 }],
    [{ source: "MIT WITH Classpath-exception-2.0", allowed: true, precedence: 3 }],
  ],
})(
  "SPDX boolean expressions follow their tree and reject unmatched parentheses and trailing tokens",
  ({ source, allowed }) => {
    expect(licenceAllowed(source)).toBe(allowed);
    expect(licenceAllowed(`(${source}`)).toBe(false);
    expect(licenceAllowed(`${source} MIT`)).toBe(false);
    expect(licenceAllowed(`${source})`)).toBe(false);
    expect(licenceAllowed(`MIT OR ${source} WITH`)).toBe(false);
    expect(licenceAllowed(`MIT OR ${source} WITH AND`)).toBe(false);
    expect(licenceAllowed(`(MIT ${source}`)).toBe(false);
  },
);

test.prop([segment, fc.array(segment, { minLength: 1 }), word])(
  "wildcard exports match paths across directories within their prefix and suffix",
  (prefix, parts, suffix) => {
    const fragment = parts.join("/");
    const exports = { [`./${prefix}/*.${suffix}`]: `./dist/${prefix}/*.${suffix}` };
    expect(exported(exports, `${prefix}/${fragment}.${suffix}`)).toBe(true);
    expect(exported(exports, `${prefix}-other/${fragment}.${suffix}`)).toBe(false);
    expect(targeted(exports, `dist/${prefix}/${fragment}.${suffix}`)).toBe(true);
    expect(targeted(exports, `dist/${prefix}/${fragment}.${suffix}.map`)).toBe(false);
  },
);

test.prop([segment, segment])("null exports leave sibling paths matchable", (dir, file) => {
  const sibling = `${dir}-other/${file}`;
  expect(exported({ "./*": "./dist/*", [`./${dir}/${file}`]: null }, sibling)).toBe(true);
  expect(exported({ "./*": "./dist/*", [`./${dir}/*`]: null }, sibling)).toBe(true);
});

test.prop([fc.array(segment), fc.array(segment)])(
  "conditional exports enumerate file targets and omit null branches",
  (esm, cjs) => {
    const paths = esm.map((name) => `./${name}.js`);
    const fallback = cjs.map((name) => `./${name}.cjs`);
    expect(
      exportTargets({ ".": { import: paths, require: [null, ...fallback] }, "./private": null }),
    ).toEqual([...paths, ...fallback]);
  },
);

test.prop([
  segment,
  segment,
  fc.constantFrom("https://example.test/", "ssh://example.test/", "git@example.test:"),
])("an owned git URL uses the organization segment and ignores its ref", (repo, ref, base) => {
  expect(ourRepository(`${base}hackersandwizards/${repo}.git#${ref}`)).toBe(true);
  expect(ourRepository(`${base}other-hackersandwizards/${repo}.git#${ref}`)).toBe(false);
  expect(ourRepository(`${base}hackersandwizards/${repo}/nested.git`)).toBe(false);
  expect(ourRepository(`${base}hackersandwizards/`)).toBe(false);
  expect(ourRepository(`${base}hackersandwizards/#${ref}`)).toBe(false);
  expect(ourRepository(`${base}unrelated/${repo}.git#${ref}/hackersandwizards/other`)).toBe(false);
});

test.prop([segment, fc.constantFrom("astro", "css")])(
  "style paths match their final extension",
  (name, extension) => {
    expect(styled(`src/${name}.${extension}`)).toBe(true);
    expect(styled(`src/${name}.${extension}.txt`)).toBe(false);
    expect(styled(`.hidden/${name}.${extension}`)).toBe(false);
    expect(styled(`src/.${name}.${extension}`)).toBe(false);
    expect(styled(`node_modules/${name}.${extension}`)).toBe(false);
  },
);

test.prop([segment, word])(
  "an allowance applies to its check, path and text together",
  (file, text) => {
    const path = `src/${file}.ts`;
    const check = "coupling";
    const pkg = {
      name: "example",
      scaffolding: { allow: [{ check, path, text, reason: "generated case" }] },
    };
    const finding = { check, path, text, message: "finding" };
    const otherFile = { ...finding, path: `test/${file}.ts` };
    const otherCheck = { ...finding, check: "structure" };
    const otherText = { ...finding, text: "9" };
    expect(applyAllow(pkg, check, [finding, otherFile, otherCheck, otherText], true)).toEqual([
      otherFile,
      otherCheck,
      otherText,
    ]);
  },
);
