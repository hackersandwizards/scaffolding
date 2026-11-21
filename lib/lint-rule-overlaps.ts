import { ownEntry } from "./json.ts";
import type { Linter } from "eslint";
import type { Finding } from "./repo.ts";

export type Rules = Record<string, unknown>;

type Processor = Linter.Processor & {
  frontmatterBlock?: string;
  reportsInOxlintRegion?: (rule: string | null) => boolean;
  oxlintRegions?: (file: string) => { ranges: unknown[]; scripts: ReadonlySet<number> } | undefined;
};

export type ESLintConfig = {
  rules?: Rules;
  processor?: Processor;
  plugins?: Record<string, { meta?: { name?: string; namespace?: string } }>;
};

export function activeSeverity(setting: unknown) {
  const severity: unknown = Array.isArray(setting) ? setting[0] : setting;
  return (
    severity === 1 ||
    severity === 2 ||
    severity === "warn" ||
    severity === "error" ||
    severity === "deny"
  );
}

export function ruleNamespace(scope: string) {
  if (scope === "@typescript-eslint") return "typescript";
  return scope.replace(/_/g, "-");
}

function eslintRuleIds(rule: string, plugins: ESLintConfig["plugins"]) {
  const separator = rule.lastIndexOf("/");
  if (separator === -1) return [rule];
  const alias = rule.slice(0, separator);
  const name = rule.slice(separator + 1);
  const meta = ownEntry(plugins, alias)?.meta;
  const scope = ruleNamespace(
    meta?.namespace ??
      meta?.name
        ?.replace(/(?:^|\/)eslint-plugin-?/, (prefix) => (prefix.startsWith("/") ? "/" : ""))
        .replace(/\/$/, "") ??
      alias,
  );
  // Some core rules in Oxlint implement both the core and TypeScript ESLint variants.
  return [
    `${scope}/${name}`,
    `${ruleNamespace(alias)}/${name}`,
    ...(scope === "typescript" ? [name] : []),
  ];
}

export function lintRuleOverlaps(
  path: string,
  native: ReadonlySet<string>,
  eslintConfig: ESLintConfig,
  region = "",
): Finding[] {
  const findings: Finding[] = [];
  for (const [rule, setting] of Object.entries(eslintConfig.rules ?? {})) {
    if (!activeSeverity(setting)) continue;
    const match = eslintRuleIds(rule, eslintConfig.plugins).find((id) => native.has(id));
    if (match === undefined) continue;
    findings.push({
      check: "structure",
      path,
      text: region,
      message: `ESLint rule ${rule} overlaps Oxlint rule ${match}. Enable the rule in only one linter for this code`,
    });
  }
  return findings;
}
