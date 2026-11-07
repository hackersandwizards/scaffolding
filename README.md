# scaffolding

How hackers&wizards sets up a code repository, as a package each repository pins by Git tag: the
skeleton every repository starts from, the commands its gate runs, the configs it shares and the
shell of its catalog.

To work on the package itself, see [Developing the package](#developing-the-package).

```sh
bun add -d github:hackersandwizards/scaffolding#v2.11.4
```

Requirements: bun 1.3 or newer, gitleaks (`brew install gitleaks`), `pdftotext` from poppler, and
on macOS `swiftc` for the OCR helper, built once per checkout into `node_modules/.cache/scaffolding/`.
A commit in a repository without `"private": true` also needs a `gh` login in the `trainers` team:
the confidential-terms check (below) fetches its list with it. The commit and push hooks run the
package's commands from `node_modules`, so each checkout, a new worktree included, needs
`bun install` first. Without it the hook stops and says so.

## Commands

| Command                   | Runs in                      | Checks                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scaffold <dir>`          | once                         | Creates a repository from `template/` with this version pinned, its catalog and admin area (below).                                                                                                                                                                                                                                                |
| `scaffolding check`       | `bun run check`              | The whole gate, below.                                                                                                                                                                                                                                                                                                                             |
| `check-structure [--fix]` | `bun run check`              | The repository against `skeleton.json`, the catalog, the gate's script names (below) and every `bin` target stored executable (100755). `--fix` writes the identical and owned files, the `.agents/skills` link, the hooks path and the `bin` modes.                                                                                               |
| `check-confidential`      | pre-commit, commit-msg, push | Terms from a hashed list, Company OS screenshots and text in images (OCR, an unread image fails), commits purged from history.                                                                                                                                                                                                                     |
| `check-staged`            | pre-commit                   | gitleaks on the index, then `check-coupling` and `check-confidential`, then prettier and eslint on the staged files and stylelint on the staged CSS and Astro ones, each refused when not installed unless `skip.format`, `skip.lint` or `skip.styles` drops the step; `validate:skills` when `.claude/` is staged, `admin-check` when an item is. |

The gate and `check-staged` also run these files from `bin/` by path; they are steps, not commands,
so a new install links none of them into `node_modules/.bin`. A link to one is left from an install
before v0.9.0, which bun keeps: it still runs, since every file in `bin/` is stored executable, and
deleting it changes nothing for the gate.

| Step                    | Runs in                     | Checks                                                                                                                                                                                                                |
| ----------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check-coupling.ts`     | `bun run check`, pre-commit | No path leaves the repository, no import past a package's `exports`, every Git dependency pinned to a tag `node_modules` holds, no disk path into a company package outside a stylesheet, and the CSS origin (below). |
| `check-lock.ts`         | `scaffolding check`         | One gate at a time per checkout.                                                                                                                                                                                      |
| `check-unique-names.ts` | `bun run check`             | Every module-scope function name outside tests is defined once.                                                                                                                                                       |
| `check-spaces.ts`       | `bun run check`             | No line break in an `.astro` template where text meets an inline tag (below).                                                                                                                                         |
| `check-licenses.ts`     | `bun run check`, pre-commit | Every installed package's licence is on the allow list or an exception pins it (below); in pre-commit when `bun.lock` or `package.json` is staged.                                                                    |
| `check-history.ts`      | `bun run check`             | No comment in a file the package ships (`bun pm pack`) names a review score, a date, a decision or item id, a review note or a founder (below).                                                                       |

## A new repository

`scaffold <dir> [--port <port>] [--name <package>]` (port 4600 and the folder's name by default)
writes the skeleton, the catalog (`catalog/astro.config.ts` on the
preset with `base: "/<name>"` and the port, an example component and story, `stylelint.config.js`,
the scripts `dev`, `catalog` and `build`, the Pages workflow) and the admin area
(`docs/agent-work/items/goal.md`), and pins brand and admin to the newest tag on their remotes, so an
admin or brand release reaches new repositories without a scaffolding release. A repository whose
catalog or admin area lives in another repository leaves either out with `--catalog-in <repo>` or
`--admin-in <repo>`; its `scaffolding.skip` names that repository. Registering the repository in
the hub's sync list, creating it on GitHub and switching Pages on stay steps for a person.

## The gate

`scaffolding check` runs `bun install --frozen-lockfile`, then the shared steps side by side:
format, lint, styles (stylelint), typecheck, structure, coupling, unique names, spaces, confidential,
history, licenses, the tests, the catalog build (`bun run build`) and admin (the item files, with the pinned
`@hackersandwizards/admin`'s `admin-check`; a repository without admin pinned needs `skip.admin`). Then the repository's own steps from
`scaffolding.check`, in order, an inner array side by side. A shared step drops only with a reason, a
non-blank string in `skip`:

```json
{
  "scaffolding": {
    "test": "test:coverage",
    "typecheck": "astro check",
    "uniqueNames": ["GET", "POST"],
    "skip": { "catalog": "no surface" },
    "check": ["check:refs", ["check:markers", "check:elements"]]
  }
}
```

**Spaces.** Astro's default `compressHTML` drops a line break where text meets an inline tag
(`a`, `code`, `span`, `strong`, `em`, `kbd`): "drawn by" on one line and `<code>brand</code>` on
the next render as "drawn bybrand". Turned off instead, it keeps every break the formatter writes,
so a wrapped link carries a space inside its underline and a bare break before punctuation shows as
a space. The template keeps compression on, and the step flags a line ending in text whose next line
starts with an inline tag, and an inline closing tag whose next line starts with a word; the fix is
the `{" "}` prettier itself writes, or joining the lines. A break no space belongs in, such as an
icon in a flex row, gets an allow entry with `text`; a repository with `compressHTML: false` skips
the step with that reason.

**History.** What a package ships is public wherever a consumer serves or bundles it, so a comment
in a shipped file says how to use the code and why, and the history behind it goes to the commit
message. The step reads the comments of every text file `bun pm pack` lists, without their marks
and with consecutive comment lines joined, so an id or a score wrapped across a line break counts.
It flags review scores and panels, a comparison of two scores (`7.94 against 7.29`, `8.4 vs 7.9`;
a three-part version or a number after a capitalised name such as `Python 3.11` is none), dates (a one-digit month counts only before a year, a closing bracket or a comma, so `only 4.7.` closing a sentence is none), decision ids, item ids (the generic `AB-1` form and the repository's own
`docs/agent-work/items/` names), paths to review notes and the founders' names. It first checks each
pattern against a line that shipped once, so a pattern that stops matching turns the step red. A
repository whose `package.json` declares no `files`, `exports` or `bin` ships nothing, and passes;
one that does needs a `version` for `bun pm pack`. A
date that is an example of a format, or a comparison of plain decimals such as `1.5 against 1.25`,
gets an allow entry with `text`, which reads the comment without its marks.

`uniqueNames` lists names the framework dictates, which the unique-names step lets repeat. Every
step in `scaffolding.check` is a script named `check:<what>`. `"private": true` skips the
confidential and history steps.

## Configs

| Export                                         | Use                                                                                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./eslint`, `./eslint/astro`                   | `export default [...base, ...]` in `eslint.config.js`                                                                                                                 |
| `./tsconfig/bun.json`, `./tsconfig/astro.json` | `"extends"` in `tsconfig.json`; `include` and `paths` stay in the repository                                                                                          |
| `./prettier`                                   | `"prettier": "@hackersandwizards/scaffolding/prettier"` in `package.json`, `.astro` included; a config adding plugins lists `...base.plugins` first                   |
| `./stylelint`                                  | `export default styles({ importFrom: [...] })` in `stylelint.config.js`                                                                                               |
| `./chrome`, `./serve`                          | Chrome for Testing, the build the repository's `puppeteer-core` pins (newest cached without one), with the shared flags; a gate server on a port the system hands out |

The stylelint base lets a stylesheet, and the `<style>` blocks of an Astro component, read only the
custom properties brand's `tokens.root.css` (from the repository's installed brand), the files in
`importFrom` and the same file define. A property a component sets from its markup (a `style`
attribute) is read with a fallback, `var(--accent, transparent)`.

## The catalog

Every repository with a surface has a catalog: the scripts `dev`, `catalog` and
`build`, its stories in `catalog/stories/` of the Astro app, and an Astro config using the preset. In a
repository whose only Astro app is the catalog, that config is `catalog/astro.config.ts`, its stories
are in `catalog/stories/` and the build lands in the repository's `dist/` unless the config sets an
`outDir` other than Astro's default `./dist`; in an Astro app it is the app's own config,
in any folder, such as `talks/astro.config.ts` with `talks/catalog/stories/`.

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

The catalog is the site's home, unless the site has a home of its own (`pages/index.*`, a
`pages/index/` folder or a top-level catch-all `pages/[...x]` under Astro's `srcDir`); then it lives
at `/catalog/`. A `redirects` entry for `/` fails the build where the catalog is the home. A catalog
that moved to the root still answers every page of its former `/catalog/` path, a forwarding page in
the build and a redirect in dev.

The home is the catalog's one index: its rail names every file under its group's label (on a phone
the groups alone, as chips) and its tiles draw each file; Astrobook draws each state, its sidebar
hidden on every page. A state's page carries a bar instead: back to the home, the file's folder and name, the
theme toggle, a link to the state alone, and the states: previous and next, with the left and right
arrow keys too, the position ("10 of 38"), and between them a link per state, or above 12 states a
menu grouped by a word three or more state names share (`BlockImage` under Block, `AccentTheme`
under Theme). The bar, rather than a list beside the canvas, keeps the canvas at full width. A camelCase state reads in
sentence case, `PrimaryOnNight` as "Primary on night", and keeps whole an acronym, a plural acronym
(`TwoPDFs` as "Two PDFs") and a few names with inner capitals (GitHub, GitLab, LinkedIn, YouTube,
JavaScript, TypeScript, OpenAI), which reads better than the export name or Title Case. A name with underscores marks its words and keeps each in its
author's case, the first capitalised: `Angebot_ohne_Preise` reads "Angebot ohne Preise", where
`AngebotOhnePreise` would read "Angebot ohne preise". So a German or proper-noun word after the
first goes in an underscore name. Every page loads in full rather than through Astrobook's client
router, which swapped pages in place and so dropped what a repository's `head` sets on `<html>` and
left its page scripts unrun.

The shell (`catalog/`: Layout, Home, Head, `render.ts`, which draws the rail and tiles, and
`catalog.css`) reads brand's token roles by name only, and the repository's `css` supplies them.
Its shapes follow brand's rule: the brand corner for a preview and a worded button, the small corner
for the search field, a rail row and the state menu, round for the state chips and the arrows.
The options beyond those above:

- `previewSize`: the tile preview's viewport in CSS px, drawn whole and scaled to the tile, for
  every group (`[794, 1123]`) or per group (`{ Pages: [1440, 900] }`); a tile without one draws its
  state at three quarters, centred on the state's own ground and shrunk where it is taller than the
  tile.
- `storyScale`: brand's `data-hw-scale` on every page that draws a story, a state's page and the
  state alone, such as `"screen"`; without it such a page keeps what the repository's `head` sets,
  else brand's default. The home is always `"dense"`.
- `title`: default "Catalog".
- `href`: where the header's lockup links, default the site's root (Astro's `base`).
- `admin`: under `astro dev`, a header link to the repository's page in the local admin hub,
  `http://admin.localhost:4329/<repo>/dashboard`, `<repo>` named as the hub names it (`admin.name`
  in `package.json`, else the checkout's folder). A built page carries none.
- `previews`: draw each tile's first state; `false` for states that load slowly or may not be
  framed.
- `previewStates`: the states a tile draws and links first, each the story's export name in kebab
  case, such as `["light", "loaded-dark"]` for `Light` and `LoadedDark`.
- `head`: the repository's own `<head>` component, rendered on every page.
- `header`: default brand's `AppHeader` and `header.css`.
- `home`: a page of the repository that renders `Home.astro`, its foundations in the default slot
  and a control such as a theme toggle in the `nav` slot. The running text above the tiles takes
  the lead's measure (48rem) and leading (1.5), unless a class of the repository's sets its own: a
  paragraph of the slot, of a wrapper element in it, or of a `details` or `section` in that
  wrapper. A paragraph deeper down, in the slot's own grid or tile, keeps its width. How long the slot's text runs is the repository's: each line it adds
  pushes the first tiles down.
- `copy`: files the built pages reach by a relative path rather than through Vite. A glob, relative
  to the repository, lands each match in the build at the same path. A package path of a package
  the repository declares, or of its own, such as `@hackersandwizards/brand/logos/avatar-512.png`,
  names one file through the package's `exports` (any other fails the build by name) and lands it
  at that path, so a page under the
  base `/mail` names it as `/mail/@hackersandwizards/brand/logos/avatar-512.png` or by the relative
  path there. `astro dev` serves each at its path. A pattern matching nothing fails the
  build, and so does, with `CI=true`, a copied file that is still a Git LFS pointer.
- `serverOnly`: every story is an Astro component, so each state renders on the server only;
  Astrobook's `client:load` branch for framework components, which bundles every story module for
  the browser, Node imports included, is dropped.

A project Pages site, published under `/<repo>/`, sets Astro's `base: "/<repo>"` in its
`defineConfig`; the catalog's links and the header's default link follow it in the build. `astro
dev` leaves the base out: it serves as if the base were `/` and redirects a page under the base
there, so only the build serves under the base, and a config sets it without a branch for dev. A
file Vite serves, a module under the Astro root such as `/catalog/Head.astro` or a file in
`public/`, stays where it is. A base ending in `/catalog`
mounts the catalog under a host with a home of its own, such as a Worker's site: the build leaves
out `public/`, which the host serves, and writes no forwarding pages.

`catalogPath({ base, pages, dev })` from `@hackersandwizards/scaffolding/catalog/path.ts` states
this rule as a pure function, for a reader such as the admin hub: `pages` are the entries of
`srcDir/pages`, and it returns the catalog's path, `/` or `/catalog/` after the base, which `dev`
drops. The preset calls it too.

Every catalog page carries `<meta name="robots" content="noindex">` and the `lead` as its
`<meta name="description">`, so a repository's head adds neither. Every page but a state alone
carries `data-hw-night`, so brand's `night.css` turns it under the theme toggle while a tile's
preview keeps its own theme. The shell's own card and pill on the home carry `data-hw-shell`, for a
check of the repository's elements to skip.

`astro dev` starts quietly: Vite's start-up scan reads the stories and the components they import,
Astro adds the components under `srcDir`, and the preset pre-bundles the client router Astrobook's layout
loads, so no dependency is found only when the first page loads. Slides' catalog, 240 pages without
an `optimizeDeps` list of its own, found none late.
Vite still says "Re-optimizing dependencies because lockfile has changed" once after each change to
`bun.lock`; a dependency the scan cannot reach goes into the repository's `optimizeDeps.include`.

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
repository. In a stylesheet, a path into `node_modules` names the file on disk and passes where an
`exports` entry targets it, a font or image under a `/*` export included.

**Installed paths.** Code, markup and data (every file `check-coupling` reads but stylesheets, Python
included, `package.json` with its scripts and tests included) name no `node_modules/@hackersandwizards/...`
path, joined or as path segments: code takes a file through
`import.meta.resolve("@hackersandwizards/brand/logos/mark.svg")`, which the package's `exports`
answer (its folder through its `./package.json`), and a command from `node_modules/.bin`; a catalog
page or its data names a file the preset's `copy` serves by its package path. Comments, a
Python docstring, `package.json`'s `scaffolding` field, a path after a Tailwind `@source` and the
repository's own package are not checked; a `.css` path counts like any other. A script whose job is to read what is installed, or a test
whose strings are data, keeps its path with an exception (below) narrowed by `text`.

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

A repository with `"scaffolding": { "private": true }` skips the check and keeps no `commit-msg`
hook, which `check-structure --fix` removes.

`check-confidential purged <sha>...` writes `.confidential-purged.json`: after a history rewrite,
the pre-push hook refuses a push from an old clone that still carries one of those commits.

The pre-push hook then hands the refs to `git lfs pre-push` where the push may carry LFS objects or
touch a lockable file. That is the case where the repository's LFS store holds a file (`lfs/objects`
in its Git directory, or under `lfs.storage`). It is also the case where a commit new to the remote
being pushed to changes a path whose `filter` attribute is `lfs` or that is `lockable`
(`.git/info/attributes` included). Git LFS reads the pushed commits itself, so a branch bringing LFS
files the checked-out tree lacks still sends its objects. A commit counts as new until that remote's
own tracking refs or the tips git reports for it hold it, so a push to a second remote still sends
objects only `origin` has. Any other push never starts git-lfs, which would otherwise verify locks
against the remote on every push. A `.lfsconfig` alone starts nothing: git-lfs checks locks only on
the files a push changes. Where git-lfs should run and is not on `PATH`, as under a client's
narrower `PATH`, the push is refused. So a file committed raw under an LFS path on a machine without
git-lfs is caught there. Where git-lfs runs, it decides as it does without this hook. The attributes
are read from each pushed branch's tip, by a Git older than 2.40 from the checked-out tree.

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
    uses: hackersandwizards/scaffolding/.github/workflows/pages.yml@v2.3.0
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
