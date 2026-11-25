export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      clause:
        "This catch discards the error even with a longer comment. Handle the one expected error and rethrow the rest, or remove the handler.",
      callback:
        "This .catch() callback discards the rejection even with a comment. Handle the one expected error and rethrow the rest, or remove the handler.",
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        if (!node.body.body.length && context.sourceCode.getCommentsInside(node.body).length)
          context.report({ node: node.body, messageId: "clause" });
      },
      CallExpression(node) {
        const { callee, arguments: args } = node;
        if (callee.type !== "MemberExpression" || args.length !== 1) return;
        const name = callee.computed ? callee.property.value : callee.property.name;
        const handler = args[0];
        if (
          name === "catch" &&
          (handler.type === "ArrowFunctionExpression" || handler.type === "FunctionExpression") &&
          handler.body.type === "BlockStatement" &&
          !handler.body.body.length
        )
          context.report({ node: handler.body, messageId: "callback" });
      },
    };
  },
};
