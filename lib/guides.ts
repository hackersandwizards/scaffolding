import { readFileSync } from "node:fs";
import { restrictionRuleName } from "./oxlint-restrictions.ts";

export const guidesDirectory = new URL("../config/guides/", import.meta.url);

export function guideId(rule: string) {
  return /\(([^()]+)\)$/.exec(rule)?.[1] ?? restrictionRuleName(rule).replace(/^csstools\//, "");
}

export function renderGuides(rules: Iterable<string>) {
  let output = "";
  for (const id of new Set(Array.from(rules, guideId))) {
    if (!/^[\w-]+$/.test(id)) continue;
    try {
      const guide = readFileSync(new URL(`${id}.md`, guidesDirectory), "utf8");
      output += `\n${guide.replace(/^# /, `[guide] ${id}: `)}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return output;
}
