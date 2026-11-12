# The catalog

Every repository with a surface has a catalog: the scripts `dev`, `catalog` and
`build`, its stories, once it has any, in `catalog/stories/` of the Astro app, and an Astro config using the preset. In a
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
at `/catalog/`. A `redirects` entry for `/` fails the build where the catalog is the home.
`/catalog/` after the base opens the catalog wherever it lives: a catalog at the root answers every
page under `/catalog/` too, a forwarding page in the build and a redirect in dev, and the shell's
own links, the header's `current` item and a state's back link, read `/catalog/`. A build opened
from disk and a page of the site's own at `/catalog/` forward nothing; there those links name the
home.

A build whose `build.assetsPrefix` is a `file://` URL is opened from disk: there every link and frame
to a page of the build names its file by file URL (`…/stories/x/index.html`), since a root-relative
path would resolve to the disk's root and a folder opens as a listing. Such a build does not serve
over HTTP.

The home is the catalog's one index: its rail names every file under its group's label (on a phone
the groups alone, as chips) and its tiles draw each file. A page that opens an entry in place marks
that entry's rail name, and only it, with `aria-current`; the shell draws it with an accent wash and
edge, darkens its group's label and, on a phone, marks the group's chip. A group's label never takes
a fill of its own. While the home scrolls, the shell's script marks the label of the group being read
with `aria-current="true"`, drawn in the accent with the same edge: the last group whose top has
passed a third of the window, else the first group; where the last group's end shows, the group the address
names where its top shows, else the last group, so a click on a group near the end marks it. On a phone
that group's chip takes the open entry's look. The rail's names scroll under the search to keep
that label in view; a mark another script set stays. Without script nothing is marked. Astrobook draws each state, its sidebar
hidden on every page. A state's page carries a bar instead: back to the home, the file's folder and name, the
theme toggle, a link to the state alone, and the states: previous and next, with the left and right
arrow keys too, the position ("10 of 38"), and between them a link per state, or above 12 states a
menu grouped by a word three or more state names share (`BlockImage` under Block, `AccentTheme`
under Theme). The bar, rather than a list beside the canvas, keeps the canvas at full width, less the room of brand's focus ring (`--hw-focus-room`, brand v2.10.0 or later, defined where
`elements/focus.css` loads), which the shell sets as `<main>`'s padding around the
story so its scrolling edge never cuts off a focused control's ring; a story's own padding on `<main>`
wins. A state alone keeps the same room where it fills the window, not inside a tile's frame. A story's file name, on its tile, in the rail and in the bar, and each camelCase state read in
sentence case (`GridSlide` as "Grid slide"; the search still finds `GridSlide`), `PrimaryOnNight` as "Primary on night", and keeps whole an acronym, a plural acronym
(`TwoPDFs` as "Two PDFs") and a few names with inner capitals (GitHub, GitLab, LinkedIn, YouTube,
JavaScript, TypeScript, OpenAI), which reads better than the export name or Title Case. A name with underscores marks its words and keeps each in its
author's case, the first capitalised: `Angebot_ohne_Preise` reads "Angebot ohne Preise", where
`AngebotOhnePreise` would read "Angebot ohne preise". So a German or proper-noun word after the
first goes in an underscore name. Every page loads in full rather than through Astrobook's client
router, which swapped pages in place and so dropped what a repository's `head` sets on `<html>` and
left its page scripts unrun.

The shell (`catalog/`: Layout, Home, Head, Top, which draws the header, `render.ts`, which draws
the rail and tiles, and `catalog.css`) reads brand's token roles by name only, and the repository's
`css` supplies them. Where brand's `tokens.json` holds a name the shell's CSS reads, the build writes
brand's value as that `var()`'s fallback, in place of any the shell writes. The bar above a story
keeps one size whatever `data-hw-scale` the story sets: `chrome.css` writes
`brand-value(--text-ui)` and `brand-value(--text-ui--line-height)`, which the build replaces with
brand's unscaled values. A repository without brand supplies the type steps the shell reads in its
`css`: `--text-page`, `--text-heading`, `--text-subheading`, `--text-ui`, `--text-micro` and the
line heights of the first four (`--text-page--line-height` and so on), `--container-measure`, the
running text's width, and `--spacing-app-header`,
its header's height, under which the rail sticks and the groups scroll to; there the bar reads its
`--text-ui` and line height as `var()`s. A program that reads the shell's CSS files itself rather
than through the build, such as a page that inlines `catalog/catalog.css`, passes each file's text
through `brandFallbacks(css, tokens)` from `catalog/fallbacks.ts` with the `tokens` of brand's
`tokens.json`: read raw, the files leave their text unsized and the bar without its size and line height, with no error.
The home's rail is brand's search field (`hw-search`) over its navigation list (`hw-nav`), so the
home's stylesheets need brand's `elements.css`, as its tiles need brand's card and pill. The shell
needs brand v2.10.0 or later, the first with both those type steps in `tokens.json` and
`--hw-focus-room`; an older brand installed fails the build.
The shapes the shell draws itself follow brand's rule: the brand corner for a preview, the small
corner for the state menu, the theme toggle and the link to a state alone, round for the phone's
group chips, the state chips and the arrows.
The options beyond those above:

- `previewSize`: the tile preview's viewport in CSS px, drawn whole and scaled to the tile, for
  every group (`[794, 1123]`) or per group (`{ Pages: [1440, 900] }`); a tile without one draws its
  state at three quarters, centred on the state's own ground and shrunk where it is taller than the
  tile: the element the state marks `data-hw-preview` alone, such as a specimen under its spec text,
  fitted to what it paints and cut to any box inside the mark clipping it, on the ground around it, the rest of the
  page hidden; else the only child of `<main>`, else `<main>`. A sized tile draws the mark alone too
  and keeps its window size. A non-empty value is a selector for the part inside the marked element
  to draw (`data-hw-preview=".part"`); one that selects nothing draws the whole mark and logs an
  error in the console. A key naming no story group fails the build.
- `themeToggle`: `false` leaves the "Dark theme" button out of a state's bar and `data-hw-night` off
  every page, for a site without a dark theme. The button reads and writes the choice under
  `theme`, the key brand's `ThemeToggle` keeps, so a choice made on the repository's own pages holds
  in its catalog and back.
- `storyScale`: brand's `data-hw-scale` on every page that draws a story, a state's page and the
  state alone, such as `"screen"`; without it such a page keeps what the repository's `head` sets,
  else brand's default. The home is always `"dense"`.
- `title`: default "Catalog".
- `href`: where the header's lockup links, default the site's root (Astro's `base`).
- `admin`: under `astro dev`, a header link to the repository's page in the local admin hub,
  `http://admin.localhost:4329/<repo>/dashboard`, `<repo>` named as the hub names it (`admin.name`
  in `package.json`, else the checkout's folder). A built page carries none.
- `previews`: draw each tile's first state; `false` for states that load slowly. A tile's frame
  loads once the home reports its first paint and the tile comes within 200 px of the view, so the
  frames neither hold the first paint back nor load all at once; without script none loads. A
  hidden page, such as a headless check's tab without focus, never paints: it loads every frame at
  once.
  `"srcdoc"` is for a site whose pages refuse framing, such as by `X-Frame-Options: DENY`: each tile
  fetches its state's page and draws its HTML, so no frame load starts that the header would block
  and a script would cancel. It needs HTTP, not a build opened from disk.
- `homeCss`: the stylesheets the home loads, default `css`. The tiles frame each state, so the home
  needs only the tokens, faces and brand's elements its header, rail and tiles read and what its
  foundations draw, such as
  `["@hackersandwizards/brand/tokens.root.css", "@hackersandwizards/brand/fonts.css", "@hackersandwizards/brand/elements.css"]`.
  `css` loads on a state alone and, without `dashboardCss`, on a state's page; the header's CSS and
  the shell's own on the home and a state's page, never on a state alone. The shell brings its
  chrome's ground and text colour, read from brand's tokens in a layer below every other, and its
  box sizing, so it draws the same with or without a reset in the lists; its faces come only from
  the lists. The home's version line names each package that `css`, `homeCss`, `dashboardCss` and
  `htmlClass`'s focus ring load a stylesheet from; a home without stories draws no such line.
- The shell's own styles (its `chrome.css` and the header's CSS) sit inline on the home and every state's page, so they cost no render-blocking request.
- `dashboardCss`: the stylesheets a state's page loads, default `css`. The page draws its story
  inline; where a repository's stories draw their state alone in an iframe there, which loads `css`,
  the page needs only the tokens and faces its header and bar read and what it draws around the
  frame, such as `["@hackersandwizards/brand/tokens.root.css", "@hackersandwizards/brand/fonts.css"]`,
  and the focus ring where the page sets `hw-focus-ring` (see `htmlClass`).
- `htmlClass`: classes on `<html>` of every page, set before the body draws, such as
  `["hw-focus-ring"]` for brand's focus ring. With that class every page loads brand's
  `elements/focus.css` ahead of its lists. A `head` that sets the class itself lists
  `"@hackersandwizards/brand/elements/focus.css"` in each list that leaves out `elements.css`, or
  that list's pages draw no focus ring.
- `previewStates`: the states a tile draws and links first, each the story's export name in kebab
  case, such as `["light", "loaded-dark"]` for `Light` and `LoadedDark`. An entry that names no
  story's state fails the build.
- `head`: the repository's own `<head>` component, rendered on every page. Ahead of it every page
  declares the cascade layer order: the shell's ground first, then, where the repository resolves
  brand v1.52.0 or later, brand's `layers.css`, so a head on such a brand declares no order of its
  own.
- `header`: default brand's `AppHeader`, `header.css` and `night.css`. The admin link, the `nav`
  option's links and whatever the home's `nav` slot holds sit in that order in one `hw-header-nav`
  group at the bar's right; a `nav` of class `hw-header-nav` passed there lays its items into that
  group.
- `nav`: the header's links on the home and on every state's page, which then carries the header
  above its bar, such as `{ items: catalogs, current: "Slides" }` with brand's `catalogs.json`. Each
  item is `{ name, href }`, an href starting with one `/` counting from the base. The item named
  `current` links to the catalog as above and carries `aria-current`: `"page"` on the home, `"true"`
  on a state's page, whose header stays above the scrolling story. A `current` that names no item
  fails the build. The links render as brand's catalog list does (`hw-header-link` in a
  `nav.hw-header-nav` with `data-hw-catalogs`). Without `nav`, the header lists brand's
  `catalogs.json` where the repository resolves `@hackersandwizards/brand`, the item named as
  `product` current; a catalog the list leaves out marks none.
- `home`: a page of the repository that renders `Home.astro`, its foundations in the default slot
  and a control such as a theme toggle in the `nav` slot. Every home opens on the tiles: the slot
  draws after the last group as the group "Foundations", the rail's last entry, hidden while the
  search holds a word. A slot holding only whitespace draws no group. Two groups whose names make
  the same anchor, such as a filled slot and a stories folder Foundations, fail the build. Its own
  headings start at `h3`, under that group's `h2`: an `h3` of the slot or of a wrapper element in
  it takes the `h2`'s face at `--text-subheading` and its line height, 2.5rem above and 0.5rem
  below, and the slot's first element sits 1rem under the `h2`, unless a class of the repository's
  sets its own. Its running text takes brand's measure (`--container-measure`) and leading (1.5), unless a class
  of the repository's sets its own: a paragraph of the slot, of a wrapper element in it, or of a
  `details` or `section` in that wrapper. A paragraph deeper down, in the slot's own grid or tile,
  keeps its width.
- `copy`: files the built pages reach by a relative path rather than through Vite. A glob, relative
  to the repository, lands each match in the build at the same path. A package path of a package
  the repository declares, or of its own, such as `@hackersandwizards/brand/logos/icon-maskable-512.png`,
  names one file through the package's `exports` (any other fails the build by name) and lands it
  at that path, so a page under the
  base `/mail` names it as `/mail/@hackersandwizards/brand/logos/icon-maskable-512.png` or by the relative
  path there. `astro dev` serves each at its path. A pattern matching nothing fails the
  build, and so does, with `CI=true`, a copied file that is still a Git LFS pointer.
- `serverOnly`: every story is an Astro component, so each state renders on the server only;
  Astrobook's `client:load` branch for framework components, which bundles every story module for
  the browser, Node imports included, is dropped. A route without that branch fails the build.

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

Every catalog page carries the `lead` as its `<meta name="description">`, or a state's own where
its story sets `args.lead`, so a repository's head adds none. A state's page and a state alone are
titled "Component: State – Product catalog", the home "Product catalog". Every page, but for a build opened
from disk, carries a `<link rel="canonical">`, so a repository's head adds none either: its own URL, and for a state
alone the state's page under `/dashboard/`. It is absolute where Astro's `site` is set and
root-relative otherwise, so a published catalog sets `site`. Where the repository resolves
`@hackersandwizards/brand`, every page carries brand's favicon; a `<link rel="icon">` in the
repository's `head` comes later and wins, while a `/favicon.ico` without a link no longer shows.
A state's `args.lead` is the same prop its component takes, so it describes that page too. The shell writes no robots tag, so search engines may index the catalog. A repository
that wants the whole catalog out of the index sets the tag in its `head`; a single page of its own
sets it in that page. Unless `themeToggle` is `false`, every page but a state alone carries `data-hw-night`, so brand's `night.css`
turns it under the theme toggle while a tile's preview keeps its own theme. A page without it draws
in the day theme, whatever theme the reader chose or the system sets, and the choice stays stored for the other pages. The shell's own card and pill on the home carry `data-hw-shell`, for a
check of the repository's elements to skip.

`astro dev` starts quietly: Vite's start-up scan reads the stories and the components they import,
Astro adds the components under `srcDir`, and the preset pre-bundles the client router Astrobook's layout
loads, so no dependency is found only when the first page loads. Slides' catalog, 240 pages without
an `optimizeDeps` list of its own, found none late.
Vite still says "Re-optimizing dependencies because lockfile has changed" once after each change to
`bun.lock`; a dependency the scan cannot reach goes into the repository's `optimizeDeps.include`.

Under an agent, `astro dev` and `astro preview` move themselves into the background, and with
`--root catalog` that background server resolves `catalog` from inside `catalog/`: dev waits 30 s
for it and fails, preview finds no `catalog/catalog/dist`. `ASTRO_DEV_BACKGROUND=1` and
`ASTRO_PREVIEW_BACKGROUND=1` keep each in the foreground and change nothing for a person. Under Bun 1.4.4 a relative `--root` makes preview look for Astrobook's routes under the root (`ENOENT` for `catalog/astrobook/pages/app.astro`), and with `"$PWD/catalog"` it serves:

```json
{
  "dev": "ASTRO_DEV_BACKGROUND=1 bun --bun astro dev --root catalog",
  "catalog": "bun run dev",
  "preview": "ASTRO_PREVIEW_BACKGROUND=1 bun --bun astro preview --root \"$PWD/catalog\""
}
```
