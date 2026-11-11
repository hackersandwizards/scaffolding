# scaffolding

How hackers&wizards sets up a code repository, as a package each repository pins by Git tag: the
skeleton every repository starts from, the commands its gate runs, the configs it shares and the
shell of its catalog.
The tokens and elements a catalog draws come from [brand](https://github.com/hackersandwizards/brand),
the item files and their hub from [admin](https://github.com/hackersandwizards/admin).

| You want                                          | Go to                                                |
| ------------------------------------------------- | ---------------------------------------------------- |
| To add the gate to a repository                   | [Install](#install), then [Use](#use)                |
| To start a new repository                         | [Use](#use)                                          |
| To know why a gate step is red, or keep a finding | [The gate](docs/gate.md)                             |
| To know why a commit was refused for a term       | [The confidential-terms check](docs/confidential.md) |
| To build a catalog                                | [The catalog](docs/catalog.md)                       |
| To set up ESLint, Prettier, TypeScript, stylelint | [Configs](docs/configs.md)                           |
| To know what the git hooks and CI run             | [Hooks and CI](docs/hooks.md)                        |
| To change this package                            | [Work on the package](#work-on-the-package)          |
| To know whether you may use it                    | [Maintainer and license](#maintainer-and-license)    |

## Install

```sh
bun add -d git+https://github.com/hackersandwizards/scaffolding.git#vX.Y.Z
```

`X.Y.Z` is the newest [tag](https://github.com/hackersandwizards/scaffolding/tags). Requirements:
bun 1.3 or newer, gitleaks (`brew install gitleaks`), `pdftotext` and `pdftoppm` from poppler, and
on macOS `swiftc` for the OCR helper, built once per checkout into `node_modules/.cache/scaffolding/`.
A commit in a repository without `scaffolding.private` also needs a `gh` login in the `trainers` team:
the [confidential-terms check](docs/confidential.md) fetches its list with it. The commit and push
hooks run the package's commands from `node_modules`, so each checkout needs `bun install` first; a
new worktree gets it from `post-checkout`. Without it the hook stops and says so.

## Use

In any checkout that installs the package, `scaffold` writes a new repository, this version pinned:

```sh
bun run scaffold ../my-repo
cd ../my-repo
bun install
bun run check
```

It writes the configs that import the package. In an existing repository,
`bun run check-structure --fix` writes the skeleton's hooks and owned files and names the other files
and settings the skeleton requires, which leave out `eslint.config.js`: copy
[`template/eslint.config.js.tmpl`](template/eslint.config.js.tmpl) with `{{eslint}}` as `eslint`, or
`eslint/astro` where the repository has Astro files. The exports most repositories import, all of them in [Configs](docs/configs.md):

- `./prettier`, `./eslint`, `./eslint/astro`, `./stylelint`: the shared format and lint configs.
- `./tsconfig/bun.json`, `./tsconfig/astro.json`: the base for `"extends"`.
- `./catalog`: the catalog preset for an Astro config ([The catalog](docs/catalog.md)).
- `./rejection`: the error a promise rejects with, as text, in a test.
- `./serve`, `./chrome`: a gate server on a free port, and Chrome for Testing.

## Commands

Each runs through `bun run`, and [Commands](docs/commands.md) has the detail of each.

- `scaffold <dir>`: creates a repository from the skeleton with this version pinned.
- `scaffolding check`: the whole gate, the script `check`.
- `check-structure [--fix]`: the repository against the skeleton; `--fix` writes it.
- `check-staged`: the pre-commit checks on the staged files.
- `check-confidential`: confidential terms, Company OS screenshots and purged commits.
- `check-lock <command>`: runs the command once no other locked command runs in the checkout.
- `chrome-mcp`: the chrome-devtools MCP server on Chrome for Testing, for `.mcp.json`.
- `raise-pins [--commit]`: raises every `@hackersandwizards/*` pin to its newest tag, then gates.

## The gate

`bun run check` runs the shared steps side by side, then the repository's own. Each step, Output
and load, Environment and the exceptions a repository keeps are in [docs/gate.md](docs/gate.md).

## Documentation

- [Commands](docs/commands.md): every command and gate step, and what `scaffold` writes.
- [The gate](docs/gate.md): its steps, load, environment, exceptions and licences.
- [Configs](docs/configs.md): every export and how to use it.
- [The catalog](docs/catalog.md): the preset, its options and what the shell draws.
- [The confidential-terms check](docs/confidential.md): the list, what it reads, the names h&w never shows.
- [Hooks and CI](docs/hooks.md): the install hooks, SessionStart, pre-push and Pages.

## Work on the package

- `bun install`
- `bun run check`: the gate on the package itself.

A release bumps `version` and pushes the tag `v<version>`; [CLAUDE.md](CLAUDE.md) has the rules.

## Maintainer and license

Maintained by hackers&wizards.

[PolyForm Strict 1.0.0](LICENSE): free for noncommercial and personal use, no redistribution or
derived works. The name hackers&wizards and its logos are not licensed.
