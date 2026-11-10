# CLAUDE.md

Public package `@hackersandwizards/scaffolding`: the repository skeleton (`template/`,
`skeleton.json`, and `template-catalog/`, which `scaffold` adds unless told the catalog lives
elsewhere), the gate commands in `bin/`, the shared configs in `config/` and the catalog
shell with its preset in `catalog/`. Repositories install it by Git tag and run the
commands through `bun run`. README.md says what each command checks.

This repository is public. No client, deal, invoice, person record, term list or Company OS
screenshot goes in, and `check-confidential` runs in its own hooks.

## Checks

`bun run check` is the full gate, `scaffolding check` run on the package itself. The catalog build
test builds a copy of `test/fixture/` with the preset. The pre-commit hook runs `bun run check:staged`.

## Releases

A changed command name, argument or exported path is a release whose commit names the change,
every such change since the previous tag, whoever made it (`git log v<previous>..HEAD`).
Bump `version` in package.json, commit, tag `v<version>`, push the tag.
