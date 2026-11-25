# CLAUDE.md

Public package `@hackersandwizards/scaffolding`: the repository skeleton (`template/`,
`skeleton.json`, and `template-catalog/`, which `scaffold` adds unless told the catalog lives
elsewhere), the gate commands in `bin/` (check-lock in `template/.githooks/`, as a skeleton file), the shared configs in `config/` and the catalog
shell with its preset in `catalog/`. Repositories install it by Git tag and run the
commands through `bun run`. docs/commands.md says what each command checks.
Rule guides live in `config/guides/`, and the gate prints them after matching findings.

This repository is public. No client, deal, invoice, person record, term list or Company OS
screenshot goes in, and `check-confidential` runs in its own hooks.

## Layers

Command entry points live in `bin/`, shared command code in `lib/`, and reusable configuration in
`config/`. The catalog may use `lib/`. The `no-restricted-imports` override in `.oxlintrc.json`
blocks relative imports from `lib/` and `config/` into `bin/`, including type imports.

## Checks

`bun run check` is the full gate, `scaffolding check` run on the package itself. It runs the Vitest
suite on Bun through `bun run test`. The catalog build test builds a copy of `test/fixture/` with the
preset. The pre-commit hook runs `bun run check:staged`.

Changed checks run the same test step with the browser, build and lock integration suites excluded.
The full gate and direct `bun run test` run every suite.

`bun run mutation` runs Stryker on the whole modules listed in `stryker.config.mjs` and writes
a fresh `.stryker-reports/mutation.json`. The wrapper caps the run at 15 minutes and lists
module-level survivors separately with an adjusted score. [Mutation testing](docs/configs.md#stryker)
describes the report. Mutation testing and `bun run scaffolding-explore` run on demand outside the gate.
[Test setup](docs/configs.md#property) describes the shared property configuration.

## Releases

A changed command name, argument or exported path is a release whose commit names the change,
every such change since the previous tag, whoever made it (`git log v<previous>..HEAD`).
Bump `version` in package.json, commit, tag `v<version>`, push the tag.
