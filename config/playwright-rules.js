import playwright from "eslint-plugin-playwright";

const playwrightCallFields = new Map([
  ["CallExpression", "callee"],
  ["TaggedTemplateExpression", "tag"],
]);
const playwrightRootFields = new Map([
  ...playwrightCallFields,
  ["MemberExpression", "object"],
  ["ChainExpression", "expression"],
]);

function playwrightReportNode(sourceCode, report, visited) {
  if (report.node) return report.node;
  const position = report.loc?.start ?? report.loc;
  if (!position) return undefined;
  const index = sourceCode.getIndexFromLoc(position);
  // A loc-only report can point inside a nested argument of the call being checked.
  if (
    playwrightCallFields.has(visited?.type) &&
    visited.range[0] <= index &&
    index < visited.range[1]
  )
    return visited;
  return sourceCode.getNodeByRangeIndex(index);
}

function playwrightReportRoot(node) {
  while (node && !playwrightCallFields.has(node.type)) node = node.parent;
  while (node && node.type !== "Identifier") node = node[playwrightRootFields.get(node.type)];
  return node;
}

const playwrightCallNames = new Set(["describe", "test", "expect"]);

function localPlaywrightCall(sourceCode, node) {
  const root = playwrightReportRoot(node);
  if (!root || !playwrightCallNames.has(root.name)) return false;
  for (let scope = sourceCode.getScope(root); scope; scope = scope.upper) {
    const variable = scope.set.get(root.name);
    if (variable)
      return (
        variable.defs.length > 0 && variable.defs.every(({ type }) => type !== "ImportBinding")
      );
  }
  return false;
}

function wrapPlaywrightRule(rule) {
  return {
    ...rule,
    create(context) {
      let visited;
      const { sourceCode } = context;
      // ESLint freezes the original rule context.
      const listeners = rule.create(
        Object.create(context, {
          report: {
            value(report) {
              const node = playwrightReportNode(sourceCode, report, visited);
              if (!localPlaywrightCall(sourceCode, node)) context.report(report);
            },
          },
        }),
      );
      return Object.fromEntries(
        Object.entries(listeners).map(([selector, listener]) => [
          selector,
          (...args) => {
            visited = args[0];
            try {
              return listener(...args);
            } finally {
              visited = undefined;
            }
          },
        ]),
      );
    },
  };
}

const recommended = Object.keys(playwright.configs["flat/recommended"].rules).filter((id) =>
  id.startsWith("playwright/"),
);

export const playwrightRecommendedErrors = Object.fromEntries(
  recommended.map((id) => [id, "error"]),
);
export const playwrightPlugin = {
  ...playwright,
  rules: {
    ...playwright.rules,
    ...Object.fromEntries(
      recommended.map((id) => {
        const name = id.slice("playwright/".length);
        return [name, wrapPlaywrightRule(playwright.rules[name])];
      }),
    ),
  },
};
