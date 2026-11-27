import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { rejection } from "../lib/rejection.js";
import {
  layerDiagram,
  mergeLayerDeclarations,
  normalizeLayerRestrictions,
  parseLayerOverride,
  renderLayers,
} from "../lib/layers.ts";
import { git } from "../lib/repo.ts";
import { installCleanGitEnvHooks } from "./git-env.ts";
import { testDirectory } from "./test-directory.ts";

installCleanGitEnvHooks();

test("counts untracked source imports and skips ignored source imports in the layer map", async () => {
  using fixture = testDirectory();
  const { folder } = fixture;
  git(["init", "-q"], folder);
  writeFileSync(
    join(folder, ".oxlintrc.json"),
    JSON.stringify({
      overrides: ["a/**", "b/**"].map((glob) => ({
        files: [glob],
        rules: { "no-restricted-imports": ["error", "unused"] },
      })),
    }),
  );
  writeFileSync(join(folder, ".gitignore"), "/a/ignored.ts\n");
  mkdirSync(join(folder, "a"));
  mkdirSync(join(folder, "b"));
  writeFileSync(join(folder, "b/target.ts"), "export const target = 1;\n");
  git(["add", "b/target.ts"], folder);
  writeFileSync(join(folder, "a/new.ts"), 'import "../b/target.ts";\n');
  writeFileSync(join(folder, "a/ignored.ts"), 'import "../b/target.ts";\n');

  expect(await renderLayers(folder)).toContain("  L0 -->|1| L1\n");
});

test.each([
  [{ group: ["third", "", "first"], message: "Use the public path" }, ["third", "", "first"]],
])("keeps the order and empty string in a legacy restriction group", (item, patterns) => {
  const restrictions = normalizeLayerRestrictions(["error", { patterns: [item] }]);
  expect(restrictions.map(({ pattern }) => pattern)).toEqual(patterns);
  expect(restrictions[0]?.message).toBe("Use the public path");
});

test.each([
  [
    { files: [""], excludeFiles: [""], rules: { "no-restricted-imports": "error" } },
    ".oxlintrc.json: the layer map needs to know which files the override covers. Set files on the layer override to a non-empty array of non-empty globs.",
  ],
])("rejects empty include globs before invalid exclude globs", (input, message) => {
  expect(() => parseLayerOverride(input)).toThrow(new Error(message));
});

test("explains why a layer config must be a regular file", async () => {
  using fixture = testDirectory();
  mkdirSync(join(fixture.folder, ".oxlintrc.json"));
  expect(await rejection(renderLayers(fixture.folder))).toBe(
    "Error: The layer map reads its rules from .oxlintrc.json. Replace that path with a regular Oxlint config file.",
  );
});

test("explains why layer overrides must be an array", async () => {
  using fixture = testDirectory();
  writeFileSync(join(fixture.folder, ".oxlintrc.json"), '{"overrides":{}}');
  expect(await rejection(renderLayers(fixture.folder))).toBe(
    "Error: .oxlintrc.json: the layer map reads layer declarations from the overrides array. Set overrides to an array of Oxlint override objects or omit it if there are no overrides.",
  );
});

test.each([
  [
    "docs",
    (path: string) => writeFileSync(path, ""),
    "docs blocks the layer map path docs/architecture/layers.md. Move the entry aside and make docs a regular directory.",
  ],
  [
    "docs/architecture/layers.md",
    (path: string) => mkdirSync(path, { recursive: true }),
    "The generator can only overwrite a regular file at docs/architecture/layers.md. Move the entry aside and run `bun run scaffolding layers --write` to generate the map.",
  ],
])(
  "explains why the layer map cannot be written with an obstruction at %s",
  (obstruction, plant, diagnostic) => {
    using fixture = testDirectory();
    const { folder } = fixture;
    git(["init", "-q"], folder);
    writeFileSync(
      join(folder, ".oxlintrc.json"),
      '{"overrides":[{"files":["src/**"],"rules":{"no-restricted-imports":"error"}}]}',
    );
    plant(join(folder, obstruction));

    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dirname, "../bin/check-layers.ts"),
        "--write",
      ],
      { cwd: folder, stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe(`[layers] ${diagnostic}\n`);
  },
);

test.each([
  [
    ["./build/**", "build/**"],
    ["second", "first"],
  ],
])("merges equal layer labels in declaration order", (files, expected) => {
  const overrides = [
    { files: files.slice(0, 1), rules: { "no-restricted-imports": ["error", "second"] } },
    { files: files.slice(1), rules: { "no-restricted-imports": ["error", "first"] } },
  ];
  const declarations = mergeLayerDeclarations(overrides);
  expect(declarations).toHaveLength(1);
  expect(
    declarations.flatMap(({ restrictions }) => restrictions.map(({ pattern }) => pattern)),
  ).toEqual(expected);
});

test.each([
  [
    ["src", "src (outside layers)"],
    [
      '  L0["src"]',
      '  L1["src (outside layers)"]',
      '  L2["src (outside layers) (outside layers)"]',
      "  L2 -->|4| L0",
    ],
  ],
])(
  "keeps source identities when a generated outside label also collides",
  ([name, existing], expected) => {
    const declared = { name: name, scopes: [] };
    const outside = { name: name };
    const nodes = new Set([outside, declared, { name: existing }]);
    const edges = new Map([[outside, new Map([[declared, 4]])]]);
    expect(layerDiagram([declared], nodes, edges)).toEqual(expected);
  },
);
