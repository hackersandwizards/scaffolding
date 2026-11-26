import { fc, test } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";
import { labelLintOverlaps, lintRuleOverlaps } from "../lib/lint-rule-overlaps.ts";

const name = fc.stringMatching(/^[a-z]{1,10}$/);
const ruleSettings = fc.constantFrom(
  [0, false, false],
  [0, true, false],
  [1, false, false],
  [1, true, true],
  [2, false, false],
  [2, true, true],
  ["off", false, false],
  ["off", true, false],
  ["warn", false, false],
  ["warn", true, true],
  ["error", false, false],
  ["error", true, true],
  ["deny", false, false],
  ["deny", true, true],
);

test.prop([fc.dictionary(name, ruleSettings), name])(
  "reports exactly the active shared rules for the file",
  (settings, file) => {
    const path = `src/${file}.ts`;
    const rules = Object.fromEntries(
      Object.entries(settings).map(([rule, [level]]) => [rule, [level, {}]]),
    );
    const native = new Set(
      Object.entries(settings)
        .filter(([, [, enabled]]) => enabled)
        .map(([rule]) => rule),
    );
    const shared = Object.entries(settings)
      .filter(([, [, , overlap]]) => overlap)
      .map(([rule]) => ({
        check: "structure",
        path,
        text: "",
        message: `ESLint rule ${rule} overlaps Oxlint rule ${rule}. Enable the rule in only one linter for this code`,
      }));
    expect(lintRuleOverlaps(path, native, { rules })).toEqual(shared);
    expect(labelLintOverlaps(lintRuleOverlaps(path, native, { rules }), "frontmatter")).toEqual(
      shared.map((finding) => ({ ...finding, text: "frontmatter" })),
    );
    expect(
      lintRuleOverlaps(path, new Set([...native].map((rule) => `another/${rule}`)), { rules }),
    ).toEqual([]);
  },
);

test.prop([fc.tuple(name, name).map(([scope, name]) => `@${scope}/${name}`), name])(
  "resolves scoped plugin aliases for both TypeScript and core Oxlint rules",
  (alias, rule) => {
    const rules = { [`${alias}/${rule}`]: "error" };
    const plugins = { [alias]: { meta: { namespace: "@typescript-eslint" } } };
    expect(
      lintRuleOverlaps("a.ts", new Set([`typescript/${rule}`]), { rules, plugins }),
    ).toHaveLength(1);
    expect(lintRuleOverlaps("a.ts", new Set([rule]), { rules, plugins })).toHaveLength(1);
  },
);
