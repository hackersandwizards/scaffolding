import { expect, test, vi } from "vitest";
import {
  boundPropertyImport,
  checkOrdinaryTestMember,
  checkPropertyDeclaration,
  checkPropertyOptions,
  checkPropertySource,
  checkPropertyTestMember,
  checkPropertyTestReferences,
  hasPropertyAssertion,
  recordPropertyImports,
  recordPropertySpecifier,
} from "../config/property-rule.js";

const sharedPackage = "@hackersandwizards/scaffolding/property";
const directMessage = `Import from ${sharedPackage} in test files.`;
const sharedMessage = `Use test.prop from ${sharedPackage}.`;
const regularMessage = "Move this example to an ordinary test file.";
const optionsMessage =
  "Use the shared property seed and case count. Pass options as an inline object.";

function ruleContext(mode: string) {
  return {
    options: [mode],
    sourceCode: { visitorKeys: {}, getDeclaredVariables: vi.fn(() => [{}]) },
    report: vi.fn<(report: { message: string }) => void>(),
  };
}

test.each([{ name: "example", expected: undefined }])(
  "stops at a shadow instead of resolving the outer property import",
  ({ name, expected }) => {
    const imported = {};
    const scope = { set: new Map([[name, {}]]), upper: { set: new Map([[name, imported]]) } };
    const imports = new Map([[imported, { from: sharedPackage, name: "test" }]]);
    expect(
      boundPropertyImport({ type: "Identifier", name }, { getScope: () => scope }, imports),
    ).toBe(expected);
  },
);

test.each([
  {
    node: {
      type: "ArrowFunctionExpression",
      body: {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          object: { name: "assert" },
          property: { name: "equal" },
        },
      },
    },
    expected: true,
  },
])("recognises a Node assert method in an expression body", ({ node, expected }) => {
  expect(hasPropertyAssertion(node, { ArrowFunctionExpression: ["body"] })).toBe(expected);
});

test.each([{ mode: "source", module: "fast-check", expected: 0 }])(
  "permits a direct fast-check import in source mode",
  ({ mode, module, expected }) => {
    const context = ruleContext(mode);
    checkPropertySource(context, {}, module);
    expect(context.report).toHaveBeenCalledTimes(expected);
  },
);

test.each([{ property: "prop", expected: sharedMessage }])(
  "reports a computed identifier instead of treating it as a literal property",
  ({ property, expected }) => {
    const identifier = {
      parent: {
        type: "MemberExpression",
        object: {},
        computed: true,
        property: { type: "Identifier", name: property },
      },
    };
    identifier.parent.object = identifier;
    const context = ruleContext("property");
    checkPropertyTestReferences(context, { references: [{ identifier }] });
    expect(context.report.mock.calls[0]?.[0].message).toBe(expected);
  },
);

test.each([{ module: "fast-check", expected: directMessage }])(
  "reports a side-effect-only direct import",
  ({ module, expected }) => {
    const context = ruleContext("test");
    const body = [{ type: "ImportDeclaration", source: { value: module }, specifiers: [] }];
    recordPropertyImports(context, { body }, new Map());
    expect(context.report.mock.calls[0]?.[0].message).toBe(expected);
  },
);

test.each([{ module: sharedPackage, expected: `Use named imports from ${sharedPackage}.` }])(
  "reports a namespace import of the shared property API",
  ({ module, expected }) => {
    const context = ruleContext("test");
    const specifier = { type: "ImportNamespaceSpecifier", parent: { source: { value: module } } };
    recordPropertySpecifier(context, specifier, new Map());
    expect(context.report.mock.calls[0]?.[0].message).toBe(expected);
  },
);

test.each([{ type: "VariableDeclarator", expected: sharedMessage }])(
  "rejects storing the result of test.prop without immediately declaring a test",
  ({ type, expected }) => {
    const context = ruleContext("property");
    const factory = { type: "CallExpression", callee: {}, parent: { type }, arguments: [[]] };
    const node = { parent: factory };
    factory.callee = node;
    checkPropertyDeclaration(context, node);
    expect(context.report.mock.calls[0]?.[0].message).toBe(expected);
  },
);

test.each([{ config: { type: "Identifier", name: "params" }, expected: optionsMessage }])(
  "requires an inline options object",
  ({ config, expected }) => {
    const context = ruleContext("property");
    checkPropertyOptions(context, { arguments: [{ type: "ArrayExpression" }, config] });
    expect(context.report.mock.calls[0]?.[0].message).toBe(expected);
  },
);

test.each([
  { binding: { from: "node:test", name: "*" }, property: "it", expected: regularMessage },
])(
  "reports an example called through the Node test namespace",
  ({ binding, property, expected }) => {
    const context = ruleContext("property");
    checkOrdinaryTestMember(
      context,
      { property: { type: "Literal", value: property }, computed: true },
      binding,
    );
    expect(context.report.mock.calls[0]?.[0].message).toBe(expected);
  },
);

test.each([
  { binding: { from: "node:test", name: "it" }, property: "prop", expected: sharedMessage },
])("rejects prop on an aliased Node it binding", ({ binding, property, expected }) => {
  const context = ruleContext("property");
  checkPropertyTestMember(
    context,
    {
      object: { name: "example" },
      property: { type: "Literal", value: property },
      computed: true,
    },
    binding,
  );
  expect(context.report.mock.calls[0]?.[0].message).toBe(expected);
});
