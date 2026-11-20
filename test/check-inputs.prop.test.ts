import { fc, test } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";
import { lostSpaceTag, spaceTemplateLines } from "../lib/astro-spaces.ts";
import {
  addedLines,
  decodeEntities,
  parsePurgedList,
  parseTermList,
} from "../lib/confidential-input.ts";
import { stagedPaths, pathChunks } from "../lib/staged-paths.ts";
import { runsMutationWrapper, usesSharedVitest } from "../lib/test-config.ts";

const word = fc.stringMatching(/^[a-z]{1,12}$/);

test.prop([word, fc.constantFrom("a", "code", "span"), fc.nat(8)])(
  "indentation preserves inline boundaries while an explicit space fixes them",
  (text, tag, spaces) => {
    const next = `${" ".repeat(spaces)}<${tag}>`;
    expect(lostSpaceTag(text, next, "", false)).toBe(tag);
    expect(lostSpaceTag(`${text}{" "}`, next, "", false)).toBeFalsy();
    expect(lostSpaceTag(`</${tag}>`, `${" ".repeat(spaces)}${text}`, "", false)).toBe(tag);
  },
);

test.prop([fc.array(word), word, fc.constantFrom("script", "style", "pre", "textarea")])(
  "blanking non-template text preserves template line numbers",
  (hidden, visible, element) => {
    const lines = [`<${element}>`, ...hidden, `</${element}>`, visible];
    const blanked = spaceTemplateLines(lines.join("\n"));
    expect(blanked).toHaveLength(lines.length);
    expect(blanked.slice(0, -1).every((line) => line.trim() === "")).toBe(true);
    expect(blanked.at(-1)).toBe(visible);
  },
);

test.prop([fc.string(), fc.array(word), fc.array(word), fc.integer({ min: 1, max: 6 })])(
  "term lists preserve valid fields and reject invalid token bounds and hash values",
  (salt, hashes, never, maxTokens) => {
    const list = { salt, hashes, maxTokens, never, built: undefined };
    expect(parsePurgedList(JSON.stringify(list))).toEqual({ salt, hashes });
    expect(parseTermList(JSON.stringify(list))).toEqual(list);
    expect(parseTermList(JSON.stringify({ ...list, maxTokens: maxTokens + 6 }))).toBeUndefined();
    expect(parseTermList(JSON.stringify({ ...list, hashes: [...hashes, 1] }))).toBeUndefined();
  },
);

test.prop([fc.integer({ min: 0, max: 0x10ffff })])(
  "decimal and hexadecimal entities decode to the same Unicode code point",
  (code) => {
    expect(decodeEntities(`&#${code};&#x${code.toString(16)};`)).toBe(
      String.fromCodePoint(code).repeat(2),
    );
  },
);

test.prop([fc.constantFrom("constructor", "toString", "valueOf", "hasOwnProperty"), word])(
  "unknown named entities stay verbatim",
  (name, text) => {
    const input = `${text}&${name};`;
    expect(decodeEntities(input)).toBe(input);
  },
);

test.prop([fc.array(word), fc.array(word), fc.array(word)])(
  "a Git patch contributes only added lines in hunks to their own paths",
  (added, removed, more) => {
    const diff = [
      "diff --git a/a b/a",
      "--- a/a",
      "+++ b/a",
      "@@ -1 +1 @@",
      ...added.map((text) => `+${text}`),
      ...removed.map((text) => `-${text}`),
      "diff --git a/b b/b",
      "--- a/b",
      "+++ b/b",
      "@@ -1 +1 @@",
      ...more.map((text) => `+${text}`),
    ].join("\n");
    const result = addedLines(diff, ["a", "b"]);
    expect(result.get("a") ?? []).toEqual(added);
    expect(result.get("b") ?? []).toEqual(more);
  },
);

test.prop([
  fc.array(
    fc.tuple(
      word,
      fc.constantFrom("A", "M", "R100", "C100", "T"),
      fc.constantFrom("100644", "120000", "160000"),
    ),
  ),
])("staged raw records use the destination and send only regular source files to lint", (files) => {
  const paths = files.map(([name], index) => `${index}-${name}.ts`);
  const raw = files
    .map(
      ([, status, mode], index) =>
        `:100644 ${mode} 1111111 2222222 ${status}\0${status === "R100" || status === "C100" ? "old.ts\0" : ""}${paths[index]}\0`,
    )
    .join("");
  expect(stagedPaths(raw)).toEqual({
    staged: paths.filter((_, index) => {
      const [, status, mode] = files[index]!;
      return mode !== "160000" && (status !== "T" || mode === "100644");
    }),
    oxlintPaths: paths.filter((_, index) => files[index]?.[2] === "100644"),
  });
});

test.prop([
  fc.array(fc.tuple(fc.constantFrom("a", "漢", "😀"), fc.integer({ min: 1, max: 19_000 })), {
    minLength: 2,
    maxLength: 8,
  }),
])("staged path chunks preserve order and bound the UTF-8 size of arguments", (paths) => {
  const files = paths.map(([letter, length]) => letter.repeat(length));
  const chunks = pathChunks(files);
  expect(chunks.flat()).toEqual(files);
  for (const chunk of chunks) {
    expect(
      chunk.reduce((bytes, file) => bytes + Buffer.byteLength(file) + 1, 0),
    ).toBeLessThanOrEqual(100_000);
  }
});

test.prop([fc.integer({ min: 1, max: 9999 }), fc.constantFrom("base", "preset", "defaults")])(
  "the shared Vitest preset must be the exported base",
  (count, preset) => {
    const source = `import ${preset} from "@hackersandwizards/scaffolding/vitest";`;
    expect(
      usesSharedVitest(
        `${source}\nexport default mergeConfig(${preset}, { test: { testTimeout: ${count} } });`,
      ),
    ).toBe(true);
    expect(usesSharedVitest(`${source}\nexport default { test: { testTimeout: ${count} } };`)).toBe(
      false,
    );
  },
);

test.prop([word, word, fc.constantFrom("", "bun run ", "bun --no-env-file ")])(
  "test script parsing recognizes the mutation wrapper as the command after environment assignments",
  (key, value, prefix) => {
    expect(
      runsMutationWrapper(`${key}='${value} value' ${prefix}scaffolding-mutation --force`),
    ).toBe(true);
    expect(runsMutationWrapper(`${key}='scaffolding-mutation' ${prefix}stryker run`)).toBe(false);
  },
);
