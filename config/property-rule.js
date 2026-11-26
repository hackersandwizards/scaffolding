const shared = "@hackersandwizards/scaffolding/property";
const direct = new Set(["fast-check", "@fast-check/vitest"]);
const testSources = new Set(["vitest", "bun:test", "node:test", "@playwright/test"]);
const testNames = new Set(["test", "it"]);
const assertNames = new Set(["expect", "expectTypeOf", "assertType", "assert"]);

const staticKey = (node, computed) =>
  !computed && node?.type === "Identifier"
    ? node.name
    : node?.type === "Literal"
      ? node.value
      : undefined;

export function boundPropertyImport(node, sourceCode, imports) {
  if (node?.type !== "Identifier") return undefined;
  for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(node.name);
    if (variable) return imports.get(variable);
  }
}

export function hasPropertyAssertion(node, visitorKeys) {
  return (
    node &&
    ((node.type === "CallExpression" &&
      ((node.callee.type === "Identifier" && assertNames.has(node.callee.name)) ||
        (node.callee.type === "MemberExpression" && node.callee.object.name === "assert"))) ||
      visitorKeys[node.type]?.some((key) => {
        const children = node[key];
        return Array.isArray(children)
          ? children.some((child) => hasPropertyAssertion(child, visitorKeys))
          : children && hasPropertyAssertion(children, visitorKeys);
      }))
  );
}

const ordinary = (context, node) =>
  context.report({ node, message: "Move this example to an ordinary test file." });
const useShared = (context, node) =>
  context.report({ node, message: `Use test.prop from ${shared}.` });

export function checkPropertySource(context, node, value) {
  if (context.options[0] !== "source" && direct.has(value))
    context.report({ node, message: `Import from ${shared} in test files.` });
}

export function checkPropertyTestReferences(context, variable) {
  for (const { identifier } of variable.references) {
    const member = identifier.parent;
    if (
      member.type !== "MemberExpression" ||
      member.object !== identifier ||
      staticKey(member.property, member.computed) !== "prop"
    )
      useShared(context, identifier);
  }
}

export function recordPropertyImports(context, program, imports) {
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const from = statement.source.value;
    checkPropertySource(context, statement, from);
    for (const specifier of statement.specifiers)
      recordPropertySpecifier(context, specifier, imports);
  }
}

export function recordPropertySpecifier(context, specifier, imports) {
  const from = specifier.parent.source.value;
  const name =
    specifier.type === "ImportSpecifier"
      ? staticKey(specifier.imported, false)
      : specifier.type === "ImportNamespaceSpecifier"
        ? "*"
        : "default";
  const [variable] = context.sourceCode.getDeclaredVariables(specifier);
  imports.set(variable, { from, name });
  if (from === shared && name === "*")
    context.report({ node: specifier, message: `Use named imports from ${shared}.` });
  if (from === shared && name === "test") checkPropertyTestReferences(context, variable);
  if (context.options[0] === "property" && testSources.has(from) && testNames.has(name))
    ordinary(context, specifier);
}

export function checkPropertyDeclaration(context, node) {
  const factory = node.parent;
  const declaration = factory.parent;
  if (
    factory.type !== "CallExpression" ||
    factory.callee !== node ||
    declaration.type !== "CallExpression" ||
    declaration.callee !== factory
  ) {
    useShared(context, node);
    return;
  }
  checkPropertyOptions(context, factory);
  const callback = declaration.arguments[1];
  if (!callback || !hasPropertyAssertion(callback, context.sourceCode.visitorKeys))
    context.report({ node: declaration, message: "A property callback must assert its result." });
}

export function checkPropertyOptions(context, factory) {
  const options = factory.arguments[1];
  if (
    factory.arguments.length > 2 ||
    factory.arguments.some((arg) => arg.type === "SpreadElement") ||
    (options &&
      (options.type !== "ObjectExpression" ||
        options.properties.some(
          (property) =>
            property.type !== "Property" ||
            [undefined, "seed", "numRuns"].includes(staticKey(property.key, property.computed)),
        )))
  )
    context.report({
      node: options ?? factory,
      message: "Use the shared property seed and case count. Pass options as an inline object.",
    });
}

export function checkOrdinaryTestMember(context, node, binding) {
  if (context.options[0] !== "property") return;
  const key = staticKey(node.property, node.computed);
  if (binding) {
    if (binding.name === "*" && testSources.has(binding.from) && testNames.has(key))
      ordinary(context, node);
    return;
  }
  if (testNames.has(node.object.name) && key !== "prop") ordinary(context, node);
}

export function checkPropertyTestMember(context, node, binding) {
  if (staticKey(node.property, node.computed) !== "prop") return;
  if (binding?.from !== shared || binding.name !== "test") {
    if (testNames.has(node.object.name) || testNames.has(binding?.name)) useShared(context, node);
    return;
  }
  if (context.options[0] !== "property") {
    context.report({
      node,
      message: "Move this property to a *.prop.test.* file so exploration can run it.",
    });
    return;
  }
  checkPropertyDeclaration(context, node);
}

export default {
  meta: { schema: [{ enum: ["source", "test", "property"] }] },
  create(context) {
    const mode = context.options[0];
    const { sourceCode } = context;
    const imports = new Map();
    return {
      Program: (node) => recordPropertyImports(context, node, imports),
      ImportExpression(node) {
        checkPropertySource(context, node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        checkPropertySource(context, node, node.source?.value);
      },
      ExportAllDeclaration(node) {
        checkPropertySource(context, node, node.source.value);
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type === "Identifier" && callee.name === "require")
          checkPropertySource(context, node, node.arguments[0]?.value);
        if (
          mode === "property" &&
          callee.type === "Identifier" &&
          testNames.has(callee.name) &&
          !boundPropertyImport(callee, sourceCode, imports)
        )
          ordinary(context, node);
      },
      MemberExpression(node) {
        const key = staticKey(node.property, node.computed);
        const binding = boundPropertyImport(node.object, sourceCode, imports);
        if (
          mode !== "source" &&
          key === "assert" &&
          binding?.from === shared &&
          binding.name === "fc"
        )
          useShared(context, node);
        checkOrdinaryTestMember(context, node, binding);
        checkPropertyTestMember(context, node, binding);
      },
    };
  },
};
