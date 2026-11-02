# scaffolding

How hackers&wizards sets up a code repository, as a package each repository pins by Git tag: the
skeleton every repository starts from and the commands its gate runs.

```sh
bun add -d github:hackersandwizards/scaffolding#v0.1.0
```

## Commands

| Command                         | Runs in                      | Checks                                                                                                                    |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `scaffold <dir>`                | once                         | Creates a repository from `template/` with this version pinned.                                                           |
| `check-structure [--fix]`       | `bun run check`              | The repository against `skeleton.json`. `--fix` writes the identical files, the `.agents/skills` link and the hooks path. |
| `check-coupling [--staged]`     | `bun run check`, pre-commit  | No path leaves the repository, no import past a package's `exports`, every Git dependency pinned to a version tag.        |
| `check-leaks`                   | pre-commit, commit-msg, push | Names from a hashed list, Company OS screenshots, images in `docs/tracking/`, commits purged from history.                |
| `check-staged`                  | pre-commit                   | gitleaks on the index, then `check-coupling` and `check-leaks`, then prettier and eslint on the staged files.             |
| `check-unique-names [names...]` | `bun run check`              | Every module-scope function name outside tests is defined once.                                                           |

## Exceptions

A finding a repository keeps goes in its `package.json` with the reason:

```json
{
  "scaffolding": {
    "allow": [
      {
        "check": "coupling",
        "path": "src/copy/*.test.ts",
        "reason": "expected output, not an import"
      }
    ]
  }
}
```

`path` takes `*` within a folder and `**` across folders, and `text` narrows an entry to findings
containing it. An entry without a reason fails, and so does one that no longer matches anything.

## The leak check

The package holds the mechanism and no names. `check-leaks build names.txt` turns one name per line
into a salted hash list. Keep that list outside every public repository, at
`~/.config/scaffolding/leak-list.json` or wherever `SCAFFOLDING_LEAK_LIST` points: with the salt
public, anyone could test whether a name is on it. Without a list the check still flags images in
`docs/tracking/` and Company OS screenshots. Images are read with the macOS Vision framework, PDFs
with `pdftotext`. A repository with `"scaffolding": { "private": true }` skips the check.

`check-leaks purged <sha>...` writes `.leak-purged.json`: after a history rewrite, the pre-push hook
refuses a push from an old clone that still carries one of those commits.

## Pipelines

Checks run locally in the git hooks and in `bun run check`. CI only builds and deploys. A
repository that publishes GitHub Pages calls the reusable workflow:

```yaml
jobs:
  pages:
    uses: hackersandwizards/scaffolding/.github/workflows/pages.yml@v0.1.0
    with:
      build: bun run build
      path: dist
    permissions:
      contents: read
      pages: write
      id-token: write
```

## Host tools

bun, gitleaks (`brew install gitleaks`), `pdftotext` from poppler, and on macOS `swiftc` for the
OCR helper, built once into `~/.cache/scaffolding/`.
