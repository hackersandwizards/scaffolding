# CLAUDE.md

Public package `@hackersandwizards/scaffolding`: the repository skeleton (`template/`,
`skeleton.json`) and the gate commands in `bin/`. Repositories install it by Git tag and run the
commands through `bun run`. README.md says what each command checks.

This repository is public. No client, deal, invoice, person record, name list or Company OS
screenshot goes in, and `check-leaks` runs in its own hooks.

## Checks

`bun run check` is the full gate: format, lint, typecheck, `bun test`, and the package's own
commands against itself. The pre-commit hook runs `bun run check:staged`.

## Releases

A changed command name, argument or exported path is a release whose commit names the change.
Bump `version` in package.json, commit, tag `v<version>`, push the tag.
