# scaffolding

How hackers&wizards sets up a code repository, as a package each repository pins by Git tag: the
skeleton every repository starts from, the commands its gate runs, the configs it shares and the
shell of its catalog.

```sh
bun add -d github:hackersandwizards/scaffolding#v0.4.0
```

## Commands

| Command                         | Runs in                      | Checks                                                                                                                                                                               |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scaffold <dir>`                | once                         | Creates a repository from `template/` with this version pinned, its catalog and admin area (below).                                                                                  |
| `scaffolding check`             | `bun run check`              | The whole gate, below.                                                                                                                                                               |
| `check-structure [--fix]`       | `bun run check`              | The repository against `skeleton.json`, the catalog and the gate's script names (below). `--fix` writes the identical and owned files, the `.agents/skills` link and the hooks path. |
| `check-coupling [--staged]`     | `bun run check`, pre-commit  | No path leaves the repository, no import past a package's `exports`, every Git dependency pinned to a tag `node_modules` holds, and the CSS origin (below).                          |
| `check-lock`                    | `scaffolding check`          | One gate at a time per checkout.                                                                                                                                                     |
| `check-confidential`            | pre-commit, commit-msg, push | Terms from a hashed list, Company OS screenshots and text in images (OCR, an unread image fails), commits purged from history.                                                       |
| `check-staged`                  | pre-commit                   | gitleaks on the index, then `check-coupling` and `check-confidential`, then prettier and eslint on the staged files.                                                                 |
| `check-unique-names [names...]` | `bun run check`              | Every module-scope function name outside tests is defined once.                                                                                                                      |

## A new repository

`scaffold <dir> --port <port>` writes the skeleton, the catalog (`catalog/astro.config.ts` on the
preset with `base: "/<name>"` and the port, an example component and story, `stylelint.config.js`,
the scripts `dev`, `catalog` and `build`, the Pages workflow) and the admin area
(`docs/tracking/items/goal.md`), and pins brand and admin to the newest tag on their remotes, so an
admin or brand release reaches new repositories without a scaffolding release. A repository whose
catalog or admin area lives in another repository leaves either out with `--catalog-in <repo>` or
`--admin-in <repo>`; its `scaffolding.skip` names that repository. Registering the repository in
the hub's sync list, creating it on GitHub and switching Pages on stay steps for a person.

## The gate

`scaffolding check` runs `bun install --frozen-lockfile`, then the shared steps side by side:
format, lint, styles (stylelint), typecheck, structure, coupling, unique names, confidential, the
tests, the catalog build (`bun run build`) and admin (the item files, with the pinned
`@hackersandwizards/admin`'s `admin-check`; a repository without admin pinned needs `skip.admin`). Then the repository's own steps from
`scaffolding.check`, in order, an inner array side by side. A shared step drops only with a reason:

```json
{
  "scaffolding": {
    "test": "test:coverage",
    "typecheck": "astro check",
    "skip": { "catalog": "no surface" },
    "check": ["check:refs", ["check:markers", "check:elements"]]
  }
}
```

Every step in `scaffolding.check` is a script named `check:<what>`. `"private": true` skips the
confidential step.

## Configs

| Export                                         | Use                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `./eslint`, `./eslint/astro`                   | `export default [...base, ...]` in `eslint.config.js`                                  |
| `./tsconfig/bun.json`, `./tsconfig/astro.json` | `"extends"` in `tsconfig.json`; `include` and `paths` stay in the repository           |
| `./prettier`                                   | `"prettier": "@hackersandwizards/scaffolding/prettier"` in `package.json`              |
| `./stylelint`                                  | `export default styles({ importFrom: [...] })` in `stylelint.config.js`                |
| `./chrome`, `./serve`                          | Chrome for Testing with the shared flags; a gate server on a port the system hands out |

The stylelint base lets a stylesheet read only the custom properties brand's `tokens.root.css`
(from the repository's installed brand) and the files in `importFrom` define.

## The catalog

Every repository with a surface has a catalog at `/catalog/`: the scripts `dev`, `catalog` and
`build`, its stories in `catalog/stories/`, and an Astro config using the preset. In a repository
whose only Astro app is the catalog, that config is `catalog/astro.config.ts` and the build lands in
`dist/`; in an Astro app it is the app's own config.

```ts
import { defineConfig } from "astro/config";
import { catalog } from "@hackersandwizards/scaffolding/catalog";

export default defineConfig({
  integrations: [
    catalog({
      product: "Dokumente",
      lead: "Every document type of the engine.",
      css: ["@hackersandwizards/brand/tokens.root.css", "@hackersandwizards/brand/elements.css"],
      previewSize: [794, 1123],
      groupOrder: ["Typen", "Komponenten"],
    }),
  ],
});
```

The shell (`catalog/`: Layout, Home, rail, tiles and `catalog.css`) reads brand's token roles by
name only, and the repository's `css` supplies them. Options beyond the four above: `title`
(default "Catalog"), `href` (default the site's root, Astro's `base`), `previews`, `previewStates` (the story names a tile draws and links first, such as `["light"]`), `head`, `header` (default brand's `AppHeader` and
`header.css`) and `home`, a page of the repository that renders `Home.astro` with its foundations
in the default slot and a control such as a theme toggle in the `nav` slot. `copy` lists globs, relative to the
repository, of files the built pages reach by a relative path rather than through Vite, such as
brand's stylesheets under `node_modules`: each match lands in the build at the same path, and a
pattern matching nothing fails the build. With `CI=true`, a copied file that is still a Git LFS
pointer fails it too.

A project Pages site, published under `/<repo>/`, sets Astro's `base: "/<repo>"` in its
`defineConfig`; the catalog's links and the header's default link follow it.

Under an agent, `astro dev` moves itself into the background, and with `--root catalog` that
background server resolves `catalog` from inside `catalog/`, so the command waits 30 s for it and
fails. `ASTRO_DEV_BACKGROUND=1` keeps it in the foreground and changes nothing for a person:

```json
{ "dev": "ASTRO_DEV_BACKGROUND=1 bun --bun astro dev --root catalog", "catalog": "bun run dev" }
```

**CSS origin.** In a repository's sources, a stylesheet from a company package comes only from
brand's `exports`; the shell's styles load only under `catalog/`; no other company package's CSS
loads outside its own repository.

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
repository that publishes GitHub Pages calls the reusable workflow, which runs `bun run build` and
publishes `dist/`. The caller, `.github/workflows/pages.yml`, is owned: where it exists,
`check-structure` compares it with the skeleton's (`surface/`) with this version filled in, and
`--fix` writes it, so a pin raise is `bun add` plus `check-structure --fix`:

```yaml
jobs:
  pages:
    uses: hackersandwizards/scaffolding/.github/workflows/pages.yml@v0.4.0
    permissions:
      contents: read
      pages: write
      id-token: write
```

## Host tools

bun, gitleaks (`brew install gitleaks`), `pdftotext` from poppler, and on macOS `swiftc` for the
OCR helper, built once per checkout into `node_modules/.cache/scaffolding/`.
