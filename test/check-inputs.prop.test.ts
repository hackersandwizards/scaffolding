import { fc, test, unicodeString } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";
import { lostSpaceTag, spaceTemplateLines } from "../lib/astro-spaces.ts";
import {
  addedLines,
  decodeEntities,
  parsePurgedList,
  parseTermList,
} from "../lib/confidential-input.ts";
import { stagedPaths, pathChunks } from "../lib/staged-paths.ts";

const word = fc.stringMatching(/^[a-z]{1,12}$/);
const line = fc.oneof(
  fc.constant(""),
  unicodeString.filter((text) => !text.includes("\n")),
);

test.prop([word, fc.constantFrom("a", "code", "span"), fc.nat(8)])(
  "indentation preserves inline boundaries while an explicit space fixes them",
  (text, tag, spaces) => {
    const next = `${" ".repeat(spaces)}<${tag}>`;
    expect(lostSpaceTag(text, next, "", false)).toBe(tag);
    expect(lostSpaceTag(`${text}{" "}`, next, "", false)).toBeFalsy();
    expect(lostSpaceTag(`{name}`, next, "", false)).toBeFalsy();
    expect(lostSpaceTag(`${text} {name}`, next, "", false)).toBe(tag);
    const expression = `{<${tag} />}`;
    expect(lostSpaceTag(text, expression, "", false)).toBeFalsy();
    expect(lostSpaceTag(text, expression, "", true)).toBe(tag);
    expect(lostSpaceTag(`</${tag}>`, expression, "", true)).toBe(tag);
    expect(lostSpaceTag(`</${tag}>`, `${" ".repeat(spaces)}${text}`, "", false)).toBe(tag);
    expect(lostSpaceTag(">", `${" ".repeat(spaces)}${text}`, `</${tag}`, false)).toBe(tag);
  },
);

test.prop([fc.array(word), word, fc.constantFrom("script", "style", "pre", "textarea")])(
  "blanking non-template text preserves template line numbers",
  (hidden, visible, element) => {
    const lines = [
      "---",
      visible,
      "---",
      `<${element}>`,
      ...hidden,
      `</${element}>`,
      `<!-- ${visible} -->`,
      `{/* ${visible} */}`,
      `// ${visible}`,
      visible,
    ];
    const blanked = spaceTemplateLines(lines.join("\n"));
    expect(blanked).toHaveLength(lines.length);
    expect(blanked.slice(0, -1).every((line) => line.trim() === "")).toBe(true);
    expect(blanked.at(-1)).toBe(visible);
  },
);

test.prop([unicodeString, fc.array(word), fc.array(word), fc.integer({ min: 1, max: 6 })])(
  "term lists preserve valid fields and reject invalid token bounds and hash values",
  (salt, hashes, never, maxTokens) => {
    const list = { salt, hashes, maxTokens, never, built: salt };
    expect(parsePurgedList(JSON.stringify(list))).toEqual({ salt, hashes });
    expect(() => parsePurgedList(JSON.stringify({ salt: maxTokens, hashes }))).toThrow(
      "expected a salt and a list of hashes",
    );
    expect(() => parsePurgedList(JSON.stringify({ salt, hashes: [...hashes, 1] }))).toThrow(
      "expected a salt and a list of hashes",
    );
    expect(parseTermList(JSON.stringify(list))).toEqual(list);
    expect(parseTermList(JSON.stringify({ ...list, never: undefined, built: 1 }))).toEqual({
      ...list,
      never: undefined,
      built: undefined,
    });
    expect(parseTermList(JSON.stringify({ ...list, salt: 1 }))).toBeUndefined();
    expect(
      parseTermList(JSON.stringify({ ...list, maxTokens: String(maxTokens) })),
    ).toBeUndefined();
    expect(parseTermList("{")).toBeUndefined();
    expect(parseTermList(JSON.stringify({ salt, hashes }))).toBeUndefined();
    expect(parseTermList(JSON.stringify({ maxTokens, hashes }))).toBeUndefined();
    expect(parseTermList(JSON.stringify({ salt, maxTokens }))).toBeUndefined();
    expect(parseTermList(JSON.stringify({ ...list, maxTokens: maxTokens + 6 }))).toBeUndefined();
    expect(parseTermList(JSON.stringify({ ...list, maxTokens: maxTokens - 6 }))).toBeUndefined();
    expect(parseTermList(JSON.stringify({ ...list, maxTokens: maxTokens - 0.5 }))).toBeUndefined();
    expect(parseTermList(JSON.stringify({ ...list, hashes: [...hashes, 1] }))).toBeUndefined();
    expect(parseTermList(JSON.stringify({ ...list, never: [...never, 1] }))).toBeUndefined();
  },
);

test.prop([fc.integer({ min: 0, max: 0x10ffff })], { examples: [[0x10ffff]] })(
  "decimal and hexadecimal entities decode to the same Unicode code point",
  (code) => {
    expect(decodeEntities(`&#${code};&#X${code.toString(16)};`)).toBe(
      String.fromCodePoint(code).repeat(2),
    );
  },
);

test.prop([
  fc.constantFrom("constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"),
  word,
])("unknown named entities stay verbatim", (name, text) => {
  const input = `${text}&${name};`;
  expect(decodeEntities(input)).toBe(input);
});

test.prop([
  fc.constantFrom(["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"]),
  word,
])(
  "known named entities decode once without changing their surrounding text",
  ([name, value], text) => {
    expect(decodeEntities(`${text}&${name};${text}`)).toBe(`${text}${value}${text}`);
    expect(decodeEntities(`&${name}`)).toBe(`&${name}`);
  },
);

test.prop([fc.nat(1000)], { examples: [[0]] })(
  "entities above the Unicode range stay verbatim",
  (offset) => {
    const code = 0x110000 + offset;
    const input = `&#${code};&#x${code.toString(16)};`;
    expect(decodeEntities(input)).toBe(input);
  },
);

test.prop([fc.array(line, { minLength: 2 }), fc.array(line), fc.array(line)])(
  "a Git patch contributes only added lines in hunks to their own paths",
  (added, removed, more) => {
    const diff = [
      "diff --git a/a b/a",
      "+before-hunk",
      "--- a/a",
      "+++ b/a",
      "@@ -1 +1 @@ preceding section",
      ...added.map((text) => `+${text}`),
      ...removed.map((text) => `-${text}`),
      "diff --git a/b b/b",
      "+outside-hunk",
      "--- a/b",
      "+++ b/b",
      "@@ -1 +1 @@",
      ...more.map((text) => `+${text}`),
      "diff --git a/extra b/extra",
      "@@ -1 +1 @@",
      "+path not supplied",
    ].join("\n");
    const result = addedLines(diff, ["a", "b"]);
    expect(result.get("a") ?? []).toEqual(added);
    expect(result.get("b") ?? []).toEqual(more);
    expect([...result.keys()].every((path) => path === "a" || path === "b")).toBe(true);
  },
);

test.prop([
  fc.array(
    fc.tuple(
      fc.tuple(word, fc.constantFrom("ts", "astro", "md", "css")),
      fc.constantFrom("A", "M", "R100", "C100", "T"),
      fc.constantFrom("100644", "100755", "120000", "160000"),
    ),
  ),
])("staged raw records use the destination and send only regular source files to lint", (files) => {
  const paths = files.map(([[name, ext]], index) => `${index} ${name}\tfile.${ext}`);
  const raw = files
    .map(
      ([, status, mode], index) =>
        `:100644 ${mode} 1111111 2222222 ${status}\0${status === "R100" || status === "C100" ? "old.ts\0" : ""}${paths[index]}\0`,
    )
    .join("");
  expect(stagedPaths(raw)).toEqual({
    staged: files.flatMap(([, status, mode], index) =>
      mode !== "160000" && (status !== "T" || mode === "100644" || mode === "100755")
        ? [paths[index]]
        : [],
    ),
    regularPaths: files.flatMap(([, , mode], index) =>
      mode === "100644" || mode === "100755" ? [paths[index]] : [],
    ),
    oxlintPaths: files.flatMap(([[, ext], , mode], index) =>
      (mode === "100644" || mode === "100755") && (ext === "ts" || ext === "astro")
        ? [paths[index]]
        : [],
    ),
  });
});

test.prop(
  [
    fc.array(fc.tuple(fc.constantFrom("a", "漢", "😀"), fc.integer({ min: 1, max: 19_000 })), {
      maxLength: 8,
    }),
  ],
  {
    examples: [
      [
        [
          ["a", 99_999],
          ["a", 1],
        ],
      ],
      [
        [
          ["a", 99_998],
          ["a", 1],
        ],
      ],
      [
        [
          ["a", 99_997],
          ["a", 1],
        ],
      ],
    ],
  },
)("staged path chunks preserve order and bound the UTF-8 size of arguments", (paths) => {
  const files = paths.map(([letter, length]) => letter.repeat(length));
  const chunks = pathChunks(files);
  expect(chunks.flat()).toEqual(files);
  for (const [index, chunk] of chunks.entries()) {
    const bytes = chunk.reduce((total, file) => total + Buffer.byteLength(file) + 1, 0);
    expect(bytes).toBeLessThanOrEqual(100_000);
    const next = chunks[index + 1]?.[0];
    if (next !== undefined) expect(bytes + Buffer.byteLength(next) + 1).toBeGreaterThan(100_000);
  }
});
