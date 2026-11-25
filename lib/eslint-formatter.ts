import { ESLint } from "eslint";
import { writeFileSync } from "node:fs";
import { renderGuides } from "./guides.ts";

const formatWithGuides: ESLint.FormatterFunction = async (results, context) => {
  const stylish = await new ESLint({ cwd: context.cwd }).loadFormatter();
  const { color, maxWarningsExceeded } = context;
  const findings = await stylish.format(results, { color, maxWarningsExceeded });
  const rules = results.flatMap(({ messages }) => messages.flatMap(({ ruleId }) => ruleId ?? []));
  // The staged check collects rule IDs on fd 3 so stdout still holds the original findings.
  if (process.env.SCAFFOLDING_STAGED_ESLINT === "1") {
    writeFileSync(3, JSON.stringify({ rules }));
    return findings;
  }
  return findings + renderGuides(rules);
};

export default formatWithGuides;
