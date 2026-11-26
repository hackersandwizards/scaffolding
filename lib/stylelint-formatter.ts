import stylelint from "stylelint";
import { renderGuides } from "./guides.ts";

const compact = await stylelint.formatters.compact;

const stylelintWithGuides: stylelint.Formatter = (results, context) => {
  const rules = results.flatMap(({ warnings }) => warnings.map(({ rule }) => rule));
  return compact(results, context) + renderGuides(rules);
};

export default stylelintWithGuides;
