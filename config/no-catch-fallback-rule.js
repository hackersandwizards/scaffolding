const guidance =
  "Decide the fallback with a check before the call (the file exists, the key is set, the value parses). Handle only the expected error and rethrow the rest, or remove the handler.";

function containsCatchReturn(node, visitorKeys) {
  if (!node) return false;
  if (node.type === "ReturnStatement") return true;
  if (/(?:FunctionExpression|FunctionDeclaration)$/.test(node.type)) return false;
  return (visitorKeys[node.type] ?? []).some((key) => {
    const child = node[key];
    return Array.isArray(child)
      ? child.some((item) => containsCatchReturn(item, visitorKeys))
      : containsCatchReturn(child, visitorKeys);
  });
}

function referencesCatchParameter(source, handler, parameter) {
  if (!parameter) return false;
  const [start, end] = parameter.range;
  const [scopeStart, scopeEnd] = (handler.type === "CatchClause" ? handler.body : handler).range;
  const inside = (node, from, to) => from <= node.range[0] && node.range[1] <= to;
  return source.getDeclaredVariables(handler).some(
    (variable) =>
      variable.identifiers.some((identifier) => inside(identifier, start, end)) &&
      variable.references.some((reference) => {
        const { identifier } = reference;
        const { parent } = identifier;
        return (
          reference.isRead() &&
          inside(identifier, scopeStart, scopeEnd) &&
          parent.type !== "ExpressionStatement" &&
          !(
            parent.type === "UnaryExpression" &&
            parent.operator === "void" &&
            parent.parent.type === "ExpressionStatement"
          )
        );
      }),
  );
}

function isCatchMethod(callee) {
  if (callee.type !== "MemberExpression") return false;
  const { computed, property } = callee;
  return computed
    ? property.type === "Literal" && property.value === "catch"
    : property.type === "Identifier" && property.name === "catch";
}

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      clause: `This catch can return without inspecting the error. ${guidance}`,
      callback: `This .catch() callback can return without inspecting the rejection. ${guidance}`,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      CatchClause(node) {
        if (
          containsCatchReturn(node.body, source.visitorKeys) &&
          !referencesCatchParameter(source, node, node.param)
        )
          context.report({ node: node.body, messageId: "clause" });
      },
      CallExpression(node) {
        if (!isCatchMethod(node.callee)) return;
        const handler = node.arguments[0];
        if (
          !handler ||
          (handler.type !== "ArrowFunctionExpression" && handler.type !== "FunctionExpression")
        )
          return;
        if (
          (handler.body.type !== "BlockStatement" ||
            containsCatchReturn(handler.body, source.visitorKeys)) &&
          !referencesCatchParameter(source, handler, handler.params[0])
        )
          context.report({ node: handler.body, messageId: "callback" });
      },
    };
  },
};
