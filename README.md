# scaffolding

How hackers&wizards sets up a code repository, as a package each repository pins by Git tag: the
skeleton every repository starts from, the commands its gate runs, the configs it shares and the
shell of its catalog.

To work on the package itself, see [Developing the package](#developing-the-package).

```sh
bun add -d github:hackersandwizards/scaffolding#v0.5.0
```

Requirements: bun 1.3 or newer, gitleaks (`brew install gitleaks`), `pdftotext` from poppler, and
on macOS `swiftc` for the OCR helper, built once per checkout into `node_modules/.cache/scaffolding/`.
A commit in a repository without `"private": true` also needs a `gh` login in the `trainers` team:
the confidential-terms check (below) fetches its list with it.

## Commands

| Command                         | Runs in                      | Checks                                                                                                                                                                                           |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scaffold <dir>`                | once                         | Creates a repository from `template/` with this version pinned, its catalog and admin area (below).                                                                                              |
| `scaffolding check`             | `bun run check`              | The whole gate, below.                                                                                                                                                                           |
| `check-structure [--fix]`       | `bun run check`              | The repository against `skeleton.json`, the catalog and the gate's script names (below). `--fix` writes the identical and owned files, the `.agents/skills` link and the hooks path.             |
| `check-coupling [--staged]`     | `bun run check`, pre-commit  | No path leaves the repository, no import past a package's `exports`, every Git dependency pinned to a tag `node_modules` holds, and the CSS origin (below).                                      |
| `check-lock`                    | `scaffolding check`          | One gate at a time per checkout.                                                                                                                                                                 |
| `check-confidential`            | pre-commit, commit-msg, push | Terms from a hashed list, Company OS screenshots and text in images (OCR, an unread image fails), commits purged from history.                                                                   |
| `check-staged`                  | pre-commit                   | gitleaks on the index, then `check-coupling` and `check-confidential`, then prettier and eslint on the staged files; `validate:skills` when `.claude/` is staged, `admin-check` when an item is. |
| `check-unique-names [names...]` | `bun run check`              | Every module-scope function name outside tests is defined once.                                                                                                                                  |
| `check-licenses`                | `bun run check`, pre-commit  | Every installed package's licence is on the allow list or an exception pins it (below); in pre-commit when `bun.lock` or `package.json` is staged.                                               |

## A new repository

`scaffold <dir> [--port <port>] [--name <package>]` (port 4600 and the folder's name by default)
writes the skeleton, the catalog (`catalog/astro.config.ts` on the
preset with `base: "/<name>"` and the port, an example component and story, `stylelint.config.js`,
the scripts `dev`, `catalog` and `build`, the Pages workflow) and the admin area
(`docs/tracking/items/goal.md`), and pins brand and admin to the newest tag on their remotes, so an
admin or brand release reaches new repositories without a scaffolding release. A repository whose
catalog or admin area lives in another repository leaves either out with `--catalog-in <repo>` or
`--admin-in <repo>`; its `scaffolding.skip` names that repository. Registering the repository in
the hub's sync list, creating it on GitHub and switching Pages on stay steps for a person.

## The gate

`scaffolding check` runs `bun install --frozen-lockfile`, then the shared steps side by side:
format, lint, styles (stylelint), typecheck, structure, coupling, unique names, confidential,
licenses, the tests, the catalog build (`bun run build`) and admin (the item files, with the pinned
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

| Export                                         | Use                                                                                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./eslint`, `./eslint/astro`                   | `export default [...base, ...]` in `eslint.config.js`                                                                                                                 |
| `./tsconfig/bun.json`, `./tsconfig/astro.json` | `"extends"` in `tsconfig.json`; `include` and `paths` stay in the repository                                                                                          |
| `./prettier`                                   | `"prettier": "@hackersandwizards/scaffolding/prettier"` in `package.json`                                                                                             |
| `./stylelint`                                  | `export default styles({ importFrom: [...] })` in `stylelint.config.js`                                                                                               |
| `./chrome`, `./serve`                          | Chrome for Testing, the build the repository's `puppeteer-core` pins (newest cached without one), with the shared flags; a gate server on a port the system hands out |

The stylelint base lets a stylesheet, and the `<style>` blocks of an Astro component, read only the
custom properties brand's `tokens.root.css` (from the repository's installed brand), the files in
`importFrom` and the same file define. A property a component sets from its markup (a `style`
attribute) is read with a fallback, `var(--accent, transparent)`.

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

The home's tiles are the catalog's one index; Astrobook draws each state, its sidebar hidden on
every page. A state's page carries a bar instead: back to the home, the file's folder and name, the
theme toggle, a link to the state alone and a link per state, folded into a disclosure above 12.

The shell (`catalog/`: Layout, Home, Head, `render.ts`, which draws the rail and tiles, and
`catalog.css`) reads brand's token roles by name only, and the repository's `css` supplies them.
The options beyond those above:

- `title`: default "Catalog".
- `href`: where the header's lockup links, default the site's root (Astro's `base`).
- `previews`: draw each tile's first state; `false` for states that load slowly or may not be
  framed.
- `previewStates`: the story names a tile draws and links first, such as `["light"]`.
- `head`: the repository's own `<head>` component, rendered on every page.
- `header`: default brand's `AppHeader` and `header.css`.
- `home`: a page of the repository that renders `Home.astro`, its foundations in the default slot
  and a control such as a theme toggle in the `nav` slot.
- `copy`: globs, relative to the repository, of files the built pages reach by a relative path
  rather than through Vite, such as brand's stylesheets under `node_modules`. Each match lands in
  the build at the same path. A pattern matching nothing fails the build, and so does, with
  `CI=true`, a copied file that is still a Git LFS pointer.

A project Pages site, published under `/<repo>/`, sets Astro's `base: "/<repo>"` in its
`defineConfig`; the catalog's links and the header's default link follow it.

Under an agent, `astro dev` moves itself into the background, and with `--root catalog` that
background server resolves `catalog` from inside `catalog/`, so the command waits 30 s for it and
fails. `ASTRO_DEV_BACKGROUND=1` keeps it in the foreground and changes nothing for a person:

```json
{
  "dev": "ASTRO_DEV_BACKGROUND=1 bun --bun astro dev --root catalog",
  "catalog": "bun run dev"
}
```

**CSS origin.** In a repository's sources, a stylesheet from a company package comes only from
brand's `exports`; the shell's styles load only under `catalog/`; an engine's stylesheet loads where
the engine's `package.json` lists it in `scaffolding.styles`, the stylesheets its components render
with (`"styles": ["./styles/slides.css"]`); no other company package's CSS loads outside its own
repository. A path into `node_modules` (a Tailwind `@source`) names the file on disk and passes
where an `exports` entry targets it.

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
For `check: "unique-names"`, `path` exempts the definition sites it covers, such as a copy another
repository syncs in.

## Licences

`check-licenses` reads bun's own `bun pm licenses --json`: every package of `bun.lock` installed in
`node_modules`, Git tags included, offline. Each licence must be on the allow list: MIT, MIT-0, ISC,
Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0, CC0-1.0, CC-BY-4.0, Python-2.0,
PSF-2.0, Unlicense, Zlib, WTFPL, OFL-1.1, MPL-2.0. In an SPDX expression an `OR` passes when one
side does, an `AND` only when every side does, and `WITH` keeps the base licence, so
`(MIT OR GPL-3.0-or-later)` passes and `Apache-2.0 AND LGPL-3.0-or-later` fails. A licence string
that is not an expression (`Unknown`, `SEE LICENSE IN LICENSE`, a URL) fails. A bun error, output
that is not the expected JSON, or no package listed fails with "run bun install".

Shipped exceptions, which may match nothing: `@hackersandwizards/*` (our own packages) and sharp's
LGPL libvips builds (`@img/sharp-libvips-*`, `@img/sharp-win32-*`, `@img/sharp-wasm32`, each with
its exact licence string), a shared library loaded on our own machines and conveyed in nothing we
hand out. A repository keeps any other package with its exact licence string and a reason, a `*`
at the end matching a name prefix:

```json
{
  "scaffolding": {
    "licenses": {
      "elkjs": { "license": "EPL-2.0", "reason": "dev only, never conveyed" }
    }
  }
}
```

An entry without a reason, matching no installed package, or whose licence string no longer
matches the installed one fails, so a new version under another licence goes red again. A red
finding names the package, its licence, `bun pm why <name>` and the entry to paste.

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
    uses: hackersandwizards/scaffolding/.github/workflows/pages.yml@v0.5.0
    permissions:
      contents: read
      pages: write
      id-token: write
```

## Developing the package

`bun install`, then `bun run check` runs the gate on the package itself: `scaffolding check`, whose
catalog test builds `test/fixture/` with the preset. A release bumps `version` in `package.json`
and pushes the tag `v<version>`; its commit names any changed command, argument or exported path.

## License

[PolyForm Strict 1.0.0](LICENSE): free for noncommercial and personal use, no redistribution or
derived works. The name hackers&wizards and its logos are not licensed.
