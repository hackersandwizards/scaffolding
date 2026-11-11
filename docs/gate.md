# The gate

`scaffolding check` runs `bun install --frozen-lockfile`, then the shared steps side by side, the
catalog build once a typecheck that runs Astro has finished:
format, lint, styles (stylelint), typecheck, structure, coupling, unique names, spaces, confidential,
history, licenses, the tests, the catalog build (`bun run build`) and admin (the item files, with the pinned
`@hackersandwizards/admin`'s `admin-check`; a repository without admin pinned needs `skip.admin`). Once those pass, the repository's own steps from
`scaffolding.check`, in order, an inner array side by side; a red one stops those after it. Format, lint and styles walk past every
submodule `.gitmodules` names, which its own repository checks. A shared step drops only with a reason, a
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

**Changed paths.** `scaffolding check --changed` (`bun run check --changed`) runs install and the
quick shared steps, and of `test`, `catalog` and the repository's own steps only those that
`scaffolding.changed` maps a changed path to: a path glob to the steps a change there needs. The
changed paths are the commits not yet on the upstream, the staged and unstaged changes and the
untracked files. Each step it leaves out prints `skipped <step>: no changed path maps to it`. The
whole gate runs, saying why, where a path matches no glob, where it is `package.json`, `bun.lock`,
`bunfig.toml` or a config every step reads (`tsconfig*.json`, `eslint.config.*`,
`prettier.config.*`, `.prettierrc*`, `.prettierignore`, `stylelint.config.*`, `astro.config.*`),
where the repository declares no map, and where git cannot list the changes. A step the map names
that the gate lacks is red on every run. The pre-push hook runs the whole gate once
([Hooks and CI](hooks.md)), so a step `--changed` skipped still goes red before the push.

```json
{ "changed": { "docs/**": ["check:refs"], "src/**": ["test", "catalog", "check:markers"] } }
```

Where the repository installs `puppeteer-core`, the gate installs the Chrome for Testing build it
pins right after `bun install`, once, so steps that start Chrome never download it side by side.

**Output and load.** Each step prints its output and its `ok` or `FAIL` line the moment it ends, and
the last line names the red steps in the gate's order. A signal to `bun run check` reaches every
step, and each step still running prints what it said so far and `stopped <step> by <signal>`.

Where the one-minute load average is above the core count, the gate says so in its first line: the
quick shared checks still run side by side, then `test` and `catalog` one after another, and each
group of the repository's own steps at most cores × cores ÷ load at a time, at least 2. `SCAFFOLDING_LOAD=<n>` replaces the measured load. Load per core also stretches
`serve`'s default wait ([Configs](configs.md)), at most ten times, and sets `SCAFFOLDING_TEST_TIMEOUT_MS` for every
step: 5000 ms on an idle machine. bun takes a per-test limit only as a flag, so the repository's
test command passes it on, `"test": "bun test --timeout ${SCAFFOLDING_TEST_TIMEOUT_MS:-5000}"`;
vitest takes `--testTimeout=${SCAFFOLDING_TEST_TIMEOUT_MS:-5000}` or reads the variable in its
config. Without it every test keeps its 5 s limit however loaded the machine is, so
`check-structure` goes red where neither `scaffolding.test`, the script it names nor a root
`vitest.config.*` or `vite.config.*` names `SCAFFOLDING_TEST_TIMEOUT_MS`.

**Environment.** No step sees a variable that only the checkout's `.env` set. Bun loads `.env`
into every `bun` process it starts, so every bin here starts `bun --no-env-file` through a `#!/bin/sh` line and a second line that is a shell command and a TypeScript comment at once, which also runs under BusyBox `env` (Alpine refuses `env -S`), and the gate and
`check-staged` pass it to every `bun` a step starts through `BUN_OPTIONS`; a tool that reads `.env` itself, such as
Vite, still does. Run them as their bins (`bun run check`); `bun bin/scaffolding.ts` without
`--no-env-file` exits 2. A step that needs a value gets it from the environment that starts the gate.

**Spaces.** Astro's default `compressHTML`, `"jsx"`, drops a line break where text meets an inline tag
(HTML's inline elements, such as `small` or `time`): "drawn by" on one line and `<code>brand</code>` on
the next render as "drawn bybrand". `true` and `false` keep each such break as a space, so a wrapped
link carries a space inside its underline and a bare break before punctuation shows as a space. The
template keeps the default, and the step flags a line ending in text, or in an
expression after words of its own (`by {name}`), whose next line starts with an inline tag, and an
inline closing tag, wrapped before its `>` too, whose next line starts with a word, an opening
bracket, a quote, a dash or one expression that draws no element (`{name}.`, `{name} <em>`). The fix is
the `{" "}` prettier itself writes, or joining the lines. A line of expressions alone counts for
neither: most lay out sibling elements. A break no space belongs in, such as an
icon in a flex row, gets an allow entry with `text`. Where every `astro.config.*` in the repository
sets `compressHTML` to `true` or `false`, the step reads only the `.astro` files a consumer can compile under its own setting: those
`bun pm pack` lists, as History below, and where package.json has `exports`, of those only the ones an
exported path names and the files they import by a relative path. There it also
flags an inline closing tag or text whose next line holds one expression whose first element is
inline (`{n > 0 && <span>{n}</span>}`): the package's pages show that space, a consumer's do not. It
reads every file again once one config returns to `"jsx"`.

**History.** What a package ships is public wherever a consumer serves or bundles it, so a comment
in a shipped file says how to use the code and why, and the history behind it goes to the commit
message. The step reads the comments of every text file `bun pm pack` lists, without their marks
and with consecutive comment lines joined, so an id or a score wrapped across a line break counts.
It flags review scores and panels (the words reviewer, persona and scored too), a comparison of two scores (`7.94 against 7.29`, `8.4 vs 7.9`;
a three-part version or a number after a capitalised name such as `Python 3.11` is none), dates (a one-digit month counts only before a year, a closing bracket or a comma, so `only 4.7.` closing a sentence is none), decision ids, item ids (the generic `AB-1` form and the repository's own
`docs/agent-work/items/` names), paths to review notes and the founders' names. It first checks each
pattern against a line that shipped once, so a pattern that stops matching turns the step red. A
repository whose `package.json` declares no `files`, `exports` or `bin` ships nothing, and passes;
one that does needs a `version` for `bun pm pack`. A
date that is an example of a format, or a comparison of plain decimals such as `1.5 against 1.25`,
gets an allow entry with `text`, which reads the comment without its marks.

A repository that pins `@hackersandwizards/brand` lists `check:retired` in `scaffolding.check`, brand's
`brand-retired` over the folders its build writes (`"check:retired": "brand-retired dist"`), or
gives `skip.retired` a reason; the gate goes red otherwise. `scaffold` writes that step for a
repository with its catalog.

`uniqueNames` lists names the framework dictates, which the unique-names step lets repeat;
Astro's `getStaticPaths` needs no entry. Every step in `scaffolding.check` is a script named
`check:<what>`. `scaffolding.private` in the index skips the confidential scan; in the working
tree, the history step.

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
Python docstring, `package.json`'s `scaffolding.allow` entries, a path after a Tailwind `@source` and the
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

`path` takes `*` within a folder and `**` across folders (`**/x.ts` covers the root's `x.ts` too), or a list of such paths, such as a
person's folder for their name. A confidential term in a file's path is that file's finding, so an
entry naming the file covers it with the file's text. `"file names"` keeps an entry to terms in a
file's path: alone it covers them in every file, beside other paths in those files only, so
`["file names", "marks/**"]` with a company's name keeps `marks/<name>.svg` and refuses the name
inside the file. package.json is
scanned without its own allow entries, so a term an entry names needs no entry for package.json. `text` narrows an entry to findings
containing it, or for a confidential term the whole term in any case, its accents composed or
not and its punctuation read as a space: `"Jane Doe"` keeps `JANE DOE`, never `Jane Doe Consulting`.
`text` may be a list, each item its own exception. An entry without a reason fails, and so does an entry, or
an item of its list, that no longer matches anything.
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
that is not the expected JSON, or no package listed fails with "run bun install". So does bun's
warning that `bun.lock` entries are not installed, unless no installed package and no workspace
needs one: Tailwind's `@tailwindcss/oxide-wasm32-wasi` uses its bundled copies, and the top-level
entries bun skips serve only packages left out on this platform.

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
