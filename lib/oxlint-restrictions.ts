import { isObject } from "./json.ts";

export const oxlintConfig = ".oxlintrc.json";

export const restrictionRuleName = (rule: string) => rule.slice(rule.lastIndexOf("/") + 1);

export function* restrictedImports(options: unknown[]) {
  for (const option of options) {
    if (typeof option === "string" || (isObject(option) && typeof option.name === "string"))
      yield { item: option, suffix: "", example: '"name": ...' };
    if (!isObject(option)) continue;
    for (const [key, example] of [
      ["paths", '"name": ...'],
      ["patterns", '"group": [...]'],
    ] as const) {
      const restrictions = option[key];
      const entries: unknown[] = Array.isArray(restrictions) ? restrictions : [];
      for (const [index, item] of entries.entries())
        yield { item, suffix: `.${key}[${index}]`, example };
    }
  }
}
