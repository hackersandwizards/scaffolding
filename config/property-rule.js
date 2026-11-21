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

export default {
  meta: { schema: [{ enum: ["source", "test", "property"] }] },
  create(context) {
    const mode = context.options[0];
    const { sourceCode } = context;
    const report = (node, message) => context.report({ node, message });
    const imports = new Map();
    const bound = (node) => {
      if (node?.type !== "Identifier") return undefined;
      for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
        const variable = scope.set.get(node.name);
        if (variable) return imports.get(variable);
      }
    };
    const assertIn = (node) =>
      node &&
      ((node.type === "CallExpression" &&
        ((node.callee.type === "Identifier" && assertNames.has(node.callee.name)) ||
          (node.callee.type === "MemberExpression" && node.callee.object.name === "assert"))) ||
        sourceCode.visitorKeys[node.type]?.some((key) => {
          const children = node[key];
          return Array.isArray(children) ? children.some(assertIn) : children && assertIn(children);
        }));
    const ordinary = (node) => report(node, "Move this example to an ordinary test file.");
    const useShared = (node) => report(node, `Use test.prop from ${shared}.`);
    const checkSource = (node, value) => {
      if (mode !== "source" && direct.has(value))
        report(node, `Import from ${shared} in test files.`);
    };
    return {
      Program(node) {
        for (const statement of node.body) {
          if (statement.type !== "ImportDeclaration") continue;
          const from = statement.source.value;
          checkSource(statement, from);
          for (const specifier of statement.specifiers) {
            const name =
              specifier.type === "ImportSpecifier"
                ? staticKey(specifier.imported, false)
                : specifier.type === "ImportNamespaceSpecifier"
                  ? "*"
                  : "default";
            const [variable] = sourceCode.getDeclaredVariables(specifier);
            imports.set(variable, { from, name });
            if (from === shared && name === "*")
              report(specifier, `Use named imports from ${shared}.`);
            if (from === shared && name === "test")
              for (const { identifier } of variable.references) {
                const member = identifier.parent;
                if (
                  member.type !== "MemberExpression" ||
                  member.object !== identifier ||
                  staticKey(member.property, member.computed) !== "prop"
                )
                  useShared(identifier);
              }
            if (mode === "property" && testSources.has(from) && testNames.has(name))
              ordinary(specifier);
          }
        }
      },
      ImportExpression(node) {
        checkSource(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        checkSource(node, node.source?.value);
      },
      ExportAllDeclaration(node) {
        checkSource(node, node.source.value);
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type === "Identifier" && callee.name === "require")
          checkSource(node, node.arguments[0]?.value);
        if (
          mode === "property" &&
          callee.type === "Identifier" &&
          testNames.has(callee.name) &&
          !bound(callee)
        )
          ordinary(node);
      },
      MemberExpression(node) {
        const key = staticKey(node.property, node.computed);
        const binding = bound(node.object);
        if (
          mode !== "source" &&
          key === "assert" &&
          binding?.from === shared &&
          binding.name === "fc"
        )
          useShared(node);
        if (
          mode === "property" &&
          ((binding?.name === "*" && testSources.has(binding.from) && testNames.has(key)) ||
            (!binding && testNames.has(node.object.name) && key !== "prop"))
        )
          ordinary(node);
        if (key !== "prop") return;
        const isSharedTest = binding?.from === shared && binding.name === "test";
        if (!isSharedTest && !testNames.has(node.object.name) && !testNames.has(binding?.name))
          return;
        if (!isSharedTest) {
          useShared(node);
          return;
        }
        if (mode !== "property") {
          report(node, "Move this property to a *.prop.test.* file so exploration can run it.");
          return;
        }
        const factory = node.parent;
        const declaration = factory.parent;
        if (
          factory.type !== "CallExpression" ||
          factory.callee !== node ||
          declaration.type !== "CallExpression" ||
          declaration.callee !== factory
        ) {
          useShared(node);
          return;
        }
        const options = factory.arguments[1];
        if (
          factory.arguments.length > 2 ||
          factory.arguments.some((arg) => arg.type === "SpreadElement") ||
          (options &&
            (options.type !== "ObjectExpression" ||
              options.properties.some(
                (property) =>
                  property.type !== "Property" ||
                  [undefined, "seed", "numRuns"].includes(
                    staticKey(property.key, property.computed),
                  ),
              )))
        )
          report(
            options ?? factory,
            "Use the shared property seed and case count. Pass options as an inline object.",
          );
        const callback = declaration.arguments[1];
        if (!callback || !assertIn(callback))
          report(declaration, "A property callback must assert its result.");
      },
    };
  },
};
