import { expect, test } from "vitest";
import {
  layerDiagram,
  mergeLayerDeclarations,
  normalizeLayerRestrictions,
  parseLayerOverride,
} from "../lib/layers.ts";

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
    "each layer must declare files globs",
  ],
])("rejects empty include globs before invalid exclude globs", (input, message) => {
  expect(() => parseLayerOverride(input)).toThrow(message);
});

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
