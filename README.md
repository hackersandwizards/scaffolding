# scaffolding

How hackers&wizards sets up a code repository, as a package each repository pins by Git tag: the
skeleton every repository starts from and the commands its gate runs.

```sh
bun add -d github:hackersandwizards/scaffolding#v0.2.0
```

## Commands

| Command                         | Runs in                      | Checks                                                                                                                         |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `scaffold <dir>`                | once                         | Creates a repository from `template/` with this version pinned.                                                                |
| `check-structure [--fix]`       | `bun run check`              | The repository against `skeleton.json`. `--fix` writes the identical files, the `.agents/skills` link and the hooks path.      |
| `check-coupling [--staged]`     | `bun run check`, pre-commit  | No path leaves the repository, no import past a package's `exports`, every Git dependency pinned to a version tag.             |
| `check-confidential`            | pre-commit, commit-msg, push | Terms from a hashed list, Company OS screenshots and text in images (OCR, an unread image fails), commits purged from history. |
| `check-staged`                  | pre-commit                   | gitleaks on the index, then `check-coupling` and `check-confidential`, then prettier and eslint on the staged files.           |
| `check-unique-names [names...]` | `bun run check`              | Every module-scope function name outside tests is defined once.                                                                |

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

## The confidential-terms check

The package holds the mechanism and no terms. The list of salted hashes lives in the private
repository `hackersandwizards/confidential-terms`, which Company OS rebuilds. `check-confidential`
fetches it with the person's own `gh` login and keeps the copy for a day in the repository's
`node_modules/.cache/scaffolding/`. The command writes nothing outside the repository, so each
checkout fetches on its own.

- No list, or a list built more than 7 days ago: every check refuses. The fix is `gh auth login`
  with an account in the `trainers` team.
- A copy older than a day is fetched again, at most once an hour. If that fails, the old copy
  counts, with a warning.
- A list built more than 3 days ago prints a warning: Company OS has stopped rebuilding it.
- Added lines, file names and the whole commit message count, comment lines included.
- An image or PDF that cannot be read refuses the commit. Images are read with the macOS Vision
  framework, so a Linux machine commits no image to a public repository. PDFs need `pdftotext`.
- With `CI=true` the term and image reading is skipped, so a deploy needs no access. The commit hook
  is the gate.
- `check-confidential fetch` fetches now, for a cloud setup script. `--list <file>` or
  `SCAFFOLDING_CONFIDENTIAL_TERMS` reads a list from a file instead.
- `check-confidential build <terms|-> [--public <file>]` turns one term per line into a list stamped
  with its build time. It leaves out every term the public text in `<file>` already carries, and
  refuses to build without `/usr/share/dict/words`.

A repository with `"scaffolding": { "private": true }` skips the check.

`check-confidential purged <sha>...` writes `.confidential-purged.json`: after a history rewrite,
the pre-push hook refuses a push from an old clone that still carries one of those commits.

## Pipelines

Checks run locally in the git hooks and in `bun run check`. The `post-merge` and `post-checkout`
hooks run `bun install --frozen-lockfile` when `bun.lock` or `package.json` changed, and
`bun run check` starts with the same install. CI only builds and deploys. A
repository that publishes GitHub Pages calls the reusable workflow:

```yaml
jobs:
  pages:
    uses: hackersandwizards/scaffolding/.github/workflows/pages.yml@v0.2.0
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
OCR helper, built once per checkout into `node_modules/.cache/scaffolding/`.
