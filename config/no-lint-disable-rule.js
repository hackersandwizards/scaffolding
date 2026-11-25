export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      directive:
        "Lint enable and disable directives are forbidden. Delete the comment, run the gate, and fix the finding using its guide.",
    },
  },
  create(context) {
    const reportDirective = (comment) => {
      if (/^(?:eslint|oxlint)-(?:disable|enable)/.test(comment.value.trimStart()))
        context.report({ loc: comment.loc, messageId: "directive" });
    };
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) reportDirective(comment);
      },
      AstroHTMLComment: reportDirective,
    };
  },
};
