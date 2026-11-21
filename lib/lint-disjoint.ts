import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  activeSeverity,
  lintRuleOverlaps,
  ruleNamespace,
  type ESLintConfig,
  type Rules,
} from "./lint-rule-overlaps.ts";
import { oxlintFiles, oxlintOutput, oxlintSource } from "./oxlint.ts";
import { jsonObject, type Finding } from "./repo.ts";

type OxlintOverride = {
  files: string[];
  excludeFiles?: string[];
  plugins?: string[] | null;
  rules: Rules;
};

type NativeRule = {
  scope: string;
  value: string;
  category: string;
  type_aware: boolean;
};

function nativeRuleId({ scope, value }: NativeRule) {
  return scope === "eslint" ? value : `${ruleNamespace(scope)}/${value}`;
}

function oxlintRules(root: string) {
  // --print-config resolves inheritance, categories and names at the root. It returns
  // ordered overrides even when called with a file path, rather than applying them.
  const config = jsonObject(oxlintOutput(root, ["--print-config"]));
  const catalog = JSON.parse(oxlintOutput(root, ["--rules", "-f", "json"])) as NativeRule[];
  const typed = new Set(catalog.filter((rule) => rule.type_aware).map(nativeRuleId));
  const overrides = ((config.overrides as OxlintOverride[] | undefined) ?? []).map((override) => ({
    ...override,
    plugins: override.plugins?.map(ruleNamespace),
    include: override.files.map((pattern) => new Bun.Glob(pattern)),
    exclude: (override.excludeFiles ?? []).map((pattern) => new Bun.Glob(pattern)),
  }));
  const categories = config.categories as Rules;
  const plugins = (config.plugins as string[]).map(ruleNamespace);

  return (file: string) => {
    const rules = new Map(Object.entries(config.rules as Rules));
    const matching = overrides.filter(
      ({ include, exclude }) =>
        include.some((glob) => glob.match(file)) && !exclude.some((glob) => glob.match(file)),
    );
    const allPlugins = new Set([
      ...plugins,
      ...matching.flatMap((override) => override.plugins ?? []),
    ]);
    // Oxlint applies categories for new plugins at the first plugin override
    // whose plugin set differs from the combined set for the file.
    const categoryOverride = matching.find(
      (override) => override.plugins && override.plugins.length !== allPlugins.size,
    );
    for (const override of matching) {
      if (override === categoryOverride && allPlugins.size !== plugins.length) {
        for (const rule of catalog) {
          const scope = ruleNamespace(rule.scope);
          const severity = categories[rule.category];
          const id = nativeRuleId(rule);
          if (allPlugins.has(scope) && !plugins.includes(scope) && !rules.has(id))
            rules.set(id, severity);
        }
      }
      for (const [id, setting] of Object.entries(override.rules)) {
        if (activeSeverity(setting)) rules.set(id, setting);
        else rules.delete(id);
      }
    }

    // The native loader uses the .astro path for both regions and does not send either
    // partial source to tsgolint. ESLint's virtual .ts path applies only to ESLint.
    const astro = file.endsWith(".astro");
    return new Set(
      [...rules]
        .filter(([id, setting]) => activeSeverity(setting) && !(astro && typed.has(id)))
        .map(([id]) => id),
    );
  };
}

export async function lintOverlaps(root: string): Promise<Finding[]> {
  const files = oxlintFiles(root)
    .filter((file) => oxlintSource.test(file))
    .sort();
  if (!files.length) return [];
  const local = createRequire(join(root, "package.json"));
  let eslintPath = "eslint";
  try {
    eslintPath = local.resolve("eslint");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
  }
  const { ESLint } = (await import(eslintPath)) as typeof import("eslint");
  const eslint = new ESLint({ cwd: root });
  const nativeRules = oxlintRules(root);
  const overlaps: Finding[] = [];
  for (const file of files) {
    if (!(await eslint.findConfigFile(file))) continue;
    const component = (await eslint.calculateConfigForFile(file)) as ESLintConfig | undefined;
    if (!component) continue;
    const native = nativeRules(file);
    if (!file.endsWith(".astro")) {
      overlaps.push(...lintRuleOverlaps(file, native, component));
      continue;
    }
    const { processor } = component;
    const absolute = join(root, file);
    const blocks =
      processor?.preprocess?.(readFileSync(absolute, "utf8").replace(/^\uFEFF/, ""), absolute) ??
      [];
    const regions = processor?.oxlintRegions?.(absolute);
    processor?.postprocess?.(
      blocks.map(() => []),
      absolute,
    );

    const componentRules = Object.fromEntries(
      Object.entries(component.rules ?? {}).filter(
        ([rule]) => processor?.reportsInOxlintRegion?.(rule) ?? true,
      ),
    );
    if (!regions || regions.ranges.length)
      overlaps.push(
        ...lintRuleOverlaps(
          file,
          native,
          { ...component, rules: componentRules },
          "Astro component in frontmatter or script",
        ),
      );
    for (const [index, block] of blocks.entries()) {
      if (typeof block === "string") continue;
      const frontmatter = block.filename === processor?.frontmatterBlock;
      if (!frontmatter && regions && !regions.scripts.has(index)) continue;
      const path = join(file, `${index}_${block.filename}`);
      const config = (await eslint.calculateConfigForFile(path)) as ESLintConfig | undefined;
      if (config)
        overlaps.push(
          ...lintRuleOverlaps(
            path,
            native,
            config,
            frontmatter ? "Astro frontmatter" : "Astro client script",
          ),
        );
    }
  }
  return overlaps;
}

export { lintRuleOverlaps } from "./lint-rule-overlaps.ts";
