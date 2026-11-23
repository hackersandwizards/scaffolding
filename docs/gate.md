# The gate

`scaffolding check` runs `bun install --frozen-lockfile`, then the shared steps side by side, the
catalog build and lint once a typecheck that runs Astro has finished (it writes the content types the typed rules read):
format, lint (ESLint), oxlint, styles (stylelint), typecheck, structure, coupling, cycles, shell, markdown, spaces, confidential, licenses, the tests, the catalog build (`bun run build`) and admin (the item files, with the pinned
`@hackersandwizards/admin`'s `admin-check`; a repository without admin pinned needs `skip.admin`). Once those pass, the repository's own steps from
`scaffolding.check`, in order, an inner array side by side; a red one stops those after it. Format, lint and styles walk past every
submodule `.gitmodules` names, which its own repository checks. A shared step drops only with a reason, a
non-blank string in `skip`:

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

**Lint.** Oxlint checks JavaScript and TypeScript, including the code in Astro frontmatter and
client scripts. ESLint checks Astro templates, the Astro plugin rules, the test rules, and rules
Oxlint cannot run with the same coverage. Both steps run unless the repository already has a
`skip.lint` reason. `check-structure` requires the shared Oxlint base and its settings in
`.oxlintrc.json`. It checks for legacy ESLint config filenames and compares the effective
rules on files both linters select, including Astro frontmatter and extracted client scripts. A rule enabled as a
warning or an error in both linters for the same code fails structure. The finding names the
file and both rule IDs. Adjust the local config so one linter owns the rule there. See
[Configs](configs.md).

The typed rules flag unhandled promises, promises used where a value or a void callback is
expected, `await` on a non-promise, incomplete switches over unions, and unsafe assignments, member
access, arguments, calls and returns. Oxlint checks that each physical TypeScript file it selects
belongs to a TypeScript project before running those rules. Add an uncovered file to its
`tsconfig.json` or import it from that project. ESLint checks the same typed rules in Astro
frontmatter and client scripts using one TypeScript program per project. Relative imports resolve
from the component's directory. The program uses the project's aliases and browser types.
Frontmatter uses the TSX conversion and module resolution from Astro's checker and reports
diagnostics in the original component.

The gate runs these rules without a file cache because imported types can change a file's verdict.
`check-staged` runs the syntax rules of both tools. For Oxlint it checks out the staged sources and
`.oxlintrc.json` into a temporary directory and links the checkout's installed dependencies.
The gate and pre-push hook run the typed rules.

When a commit touches `.claude/`, `check-staged` compares the `package.json` scripts in the index
with those in the working tree. It refuses the commit and names a differing script if any script
changed. If the scripts match and define `check:skills`, the hook runs `bun run check:skills` with
`VALIDATE_SKILLS_PATHS` set to the staged paths, including deletions. The validator reads skill
files from the working tree.

**Cycles.** The `cycles` step fails on a runtime import cycle, a local import that resolves outside
the checkout, or a relative import (`./` or `../`) that does not resolve to a file. Findings name
the original source paths. Take another repository's code from its published package. Installed
packages under `node_modules` pass the checkout-boundary check. Relative asset imports resolve
against the checkout, including assets omitted from the Astro mirror and suffixes such as `?raw`.
Unresolved package and alias specifiers pass.
The step compiles tracked `.astro` files and passes them to dependency-cruiser alongside JavaScript
and TypeScript. Imports resolve using the root `tsconfig.json`'s path aliases. Each compiled client
script is a separate module from its component's server code. The check ignores imports TypeScript
erases, including `import type`. To fix a runtime cycle, move shared code into a module that
neither side imports back from. The step reads no allow list. Submodule cycles belong to their
own repositories.

**Shell.** ShellCheck runs at warning severity over tracked `.sh` and `.bash` files and files with
an sh, bash, dash or ksh shebang. Other scripting extensions, including TypeScript, JavaScript
and Python, take precedence over the shebang. The step skips symlinked scripts and unmerged index
entries. It uses the root `.shellcheckrc` when present and reports when there are no scripts.
Run `bun run scaffolding shell` to check shell scripts on demand. When there are findings, both the
gate and pre-commit output end the ShellCheck report with a reminder to repair each finding in the
script.

**Markdown.** `bun run scaffolding markdown` checks all tracked `.md` files with
markdownlint-cli2. It skips symlinks, submodules and `node_modules`. The package supplies the rules,
including for repositories with local markdownlint configuration. Use
`bun run scaffolding markdown --fix` to apply markdownlint's fixes to the working tree. Findings
that require manual edits still fail the command. When there are findings, both the gate and
pre-commit output end the Markdown report with the fix command and a reminder to repair remaining
findings by changing only Markdown structure and preserving every word. The gate accepts
`scaffolding.skip.markdown` with a reason to skip the whole step.

| Rule            | Setting and reason                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| MD013           | Off. Documents wrap past 80 columns, including tables, URLs and paths.                                |
| MD034           | Off. Bare URLs cite sources in table cells.                                                           |
| MD060           | Off. The formatter does not pad every table.                                                          |
| MD033           | Allow `br` for line breaks within HTML-capable Markdown.                                              |
| MD029           | Off. Step numbering can continue across headings.                                                     |
| MD026           | Off. Headings can end with a colon or question mark.                                                  |
| MD037 and MD038 | Off. The rules misread expressions such as `a * b * c` and globs, which their fixers rewrite.         |
| MD010           | Ignore tabs inside code blocks so examples retain their indentation.                                  |
| MD024           | Compare duplicate headings within the same section so different sections can use the same subheading. |
| MD041           | Accept a top-level YAML `title` or `name` because content records carry their title in frontmatter.   |
| MD025           | Allow one H1 in the body, including when frontmatter supplies the document title.                     |

At pre-commit, `check-staged` checks only the staged shell scripts and Markdown files, using
their content from the index. ShellCheck's snapshot also includes all tracked shell scripts
and the root `.shellcheckrc` from the index so staged scripts can source unchanged scripts.
The hook uses the corresponding `skip.shell` and `skip.markdown` reasons in the staged package
manifest.

## Changed paths

`scaffolding check --changed` (`bun run check --changed`) always runs frozen install, then
each enabled step among format, structure, coupling, spaces, confidential, licenses, admin and pins.
Paths are repository-relative, case-sensitive Bun globs. Every match adds its steps.

The gate sets `SCAFFOLDING_CHANGED` for each step. A value of `1` marks a changed check and `0`
marks a full check.

| Default paths                                                                                                         | Additional steps                              |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts,astro,mdx}`                                                                      | typecheck, lint, oxlint, cycles, test         |
| `**/*.{astro,mdx}`                                                                                                    | styles                                        |
| `**/*.{css,scss,sass,less}`                                                                                           | styles, test                                  |
| `{src,app,lib,bin,components,pages,catalog,site,talks,scripts,test,tests,fixtures,data,content,public,assets,e2e}/**` | typecheck, lint, oxlint, styles, cycles, test |
| `**/*.md`                                                                                                             | markdown                                      |
| `**/*.{sh,bash}`, `**/.shellcheckrc`, shell shebangs                                                                  | shell                                         |
| `docs/**/*.txt`, `.claude/skills/**/*.{yaml,yml}`                                                                     | Always-run steps only                         |

The shell and Markdown matches add their steps. A path covered only by those matches still
selects all enabled fast steps under the fallback, as does an unmatched path or a path below.

- `**/package.json`
- `**/{bun.lock,bun.lockb,package-lock.json,pnpm-lock.yaml,yarn.lock,bunfig.toml,.npmrc}`
- `**/{tsconfig*.json,eslint.config.*,oxlint.config.*,.oxlintrc*,prettier.config.*,.prettierrc*,.prettierignore,stylelint.config.*,.stylelintrc*,.stylelintignore,astro.config.*,vite.config.*,vitest.config.*,playwright*.config.*}`
- `.gitmodules`, `.githooks/**`, `.github/workflows/**`, `.gitlab-ci.yml`

The pre-push hook passes every pushed branch's range as `--changed <from>..<to>...`. The gate
unions the paths across ranges, including both paths of a rename and the old path of a deletion.
It reads shell shebangs at both ends of a pushed range. A local changed check reads them in the
base commit and the working tree.
A new branch, unreadable range, non-fast-forward update or failed Git enumeration selects all fast
steps and prints the reason. Without explicit ranges, the gate compares the working tree to the
upstream merge base, or to `HEAD` without an upstream, and includes untracked files. Each selected
step still checks the working tree. Shell and Markdown lint judge new files once they are staged,
even if an untracked path already selected the step. Astro lint also selects the enabled
typecheck that generates its content types and waits for it.

### package.json fields

`scaffolding.changed` adds paths and steps to the default map. Every entry takes a relative glob
and a non-empty list of registered gate steps. A local path can match only your map. A
`check:<what>` in `scaffolding.check` runs on any path until you name it in `scaffolding.changed`.
Once scoped, it runs where a local glob selects it or when the gate falls back to every fast step.
Map dependent local steps to the same paths if they need fresh output from each other.

`scaffolding.fullOnly` maps `test` and registered `check:<what>` steps to non-blank reasons.
The shared `catalog` build is always full-only. The gate validates both fields in either mode.
An existing path map can still name a full-only step. The changed gate prints each selection,
skip and deferral with its reason. The full gate runs full-only steps in their usual order.

At the version raise, use the release commit's consumer list to add `scaffolding.fullOnly`
reasons for suites that launch a browser, build or check generated output. Keep those commands in
the full gate and keep fast unit commands eligible for path selection. A repository with no
full-only marks runs every enabled non-catalog step at push on an unmapped path. Recognized paths
use the table and local map. Config and Git fallbacks also run every eligible fast step.

```json
{
  "scaffolding": {
    "test": "test",
    "check": ["check:refs", "check:preview"],
    "changed": { "docs/**": ["check:refs"] },
    "fullOnly": { "check:preview": "builds and checks the preview site" }
  }
}
```

Where the repository installs `puppeteer-core`, the full gate prepares its pinned Chrome for
Testing just after install. A changed run prepares Chrome if it selects a test or a local command
that may launch it.

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
config. A test that sets its own limit scales it the same way,
`ms * Number(process.env.SCAFFOLDING_TEST_TIMEOUT_MS || 5000) / 5000`: a fixed 30 s limit timed out
under load where the default had stretched. Without it every test keeps its 5 s limit however loaded the machine is, so
`check-structure` requires the test command, a script it runs or a root `vitest.config.*` or
`vite.config.*` to use `SCAFFOLDING_TEST_TIMEOUT_MS`. A config can export the shared Vitest base
directly or pass it as the first argument to `mergeConfig`. See [Configs](configs.md).

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
`bun pm pack` lists (a repository whose `package.json` declares no `files`, `exports` or `bin` ships none), and where package.json has `exports`, of those only the ones an
exported path names and the files they import by a relative path. There it also
flags an inline closing tag or text whose next line holds one expression whose first element is
inline (`{n > 0 && <span>{n}</span>}`): the package's pages show that space, a consumer's do not. It
reads every file again once one config returns to `"jsx"`.

### Brand checks

Pinning `@hackersandwizards/brand` enables four steps. The gate runs `colours` and `copies`
alongside the shared static checks. A changed check selects `colours` for styling and component
sources, its allowlist and Git ignore changes. `copies` reads every kind of file for byte matches,
so any changed path selects it. Both scanners apply brand's own file exclusions.

`retired` and `elements` run in the full gate after the catalog build. Put their names in
`scaffolding.check` to keep their position relative to a local step, including a preview build.
Full shared steps without an explicit position run side by side after the local groups.
Use `scaffolding.brand.retired` to name the built paths to scan. `scaffolding.brand.directory`
sets the working directory for colours and elements, and retired paths stay relative to the
repository root. Set `scaffolding.brand.elements` to `"server"` to pass `--base {url}` through
`with-server`. Declare the server once, with optional readiness timeout in seconds and stderr
forwarding.

```json
{
  "brand": { "retired": ["dist"], "elements": "server" },
  "server": { "command": "bun dist/server/entry.mjs", "timeout": 120, "stderr": true }
}
```

A `check:<name>` script listed in `scaffolding.check` takes the place of its shared brand step.
The gate prints `retired uses local check:retired` for that choice, then reports the result
under the script's name. The script keeps its existing group, changed scopes and `fullOnly` reason.
The manifest must declare retired paths, list `check:retired` or give `skip.retired` a reason.
`scaffold` declares `dist` for its starter catalog and skips elements until the repository
declares pages for the check.

Other entries in `scaffolding.check` are scripts named `check:<what>`. `scaffolding.private` in
the index skips the confidential scan.

### Internal links

`scaffolding.server` enables the full-gate `links` crawl. Each check starts its own server with
`PORT` and `HOST` set by `with-server`. Server-backed `elements` uses the same declaration.
`scaffolding.linkSkips` lists optional path prefixes, such as `["/catalog"]`. The shared crawl
passes each as a separate `--skip` argument to `check-links`.

Put `links` in `scaffolding.check` where the crawl needs a specific position, such as after
`check:preview`. A listed `check:links` replaces the shared crawl and keeps its existing group.
The gate prints `links uses local check:links` when a server is declared and the local script
owns the crawl.

### Slides pins

Pinning `@hackersandwizards/slides` enables the fast `pins` step. It runs that version's
`slides-pins` to check the consumer's manifest against the slides engine's brand requirement.
The slides package keeps its own `check:pins` step. A consumer that still lists `check:pins`
sees `pins uses local check:pins` until it removes that entry.

### Browser tests

Set `"browserTest": "test/pages"` in `scaffolding` to split a Vitest suite by folder. The shared
`test` step runs `bun --bun vitest run --exclude 'test/pages/**'` and the full-only
`browser-test` step runs `bun --bun vitest run test/pages` after the build. Place `browser-test`
in `scaffolding.check` to keep its order relative to local steps. The mail engine uses
`"browserTest": "test/browser"`.

The folder supplies the default Vitest command for both steps. Omit `scaffolding.test` or set it to
`"bun --bun vitest run"`. To retain `bun run test [<vitest args>...]` on demand, set
`"scripts": { "test": "scaffolding test" }`. The subcommand forwards additional Vitest arguments
and uses the same exclusion. Brand's integration and catalog suites stay project-based because
their Vitest projects select different files and its integration command clears Git variables.

### Migrating consumer manifests

Raise the scaffolding pin before using the new manifest keys. The old local scripts can run on
the new pin during the transition. Remove the listed `scripts.check:*` entries with their
`fullOnly` reasons. In `scaffolding.check`, drop the fast entries and replace each listed
full-gate entry with the shared name in the same position. Replace `check:pages` and
`check:modes` with `browser-test`. Keep each other entry in its current group.

A server command goes in `server.command`. Declare retired paths in `brand.retired`, and set
`brand.elements` to `"server"` only in the rows that pass the server URL to elements.

| Consumer             | Remove local check scripts                                                                      | Add declarations and preserve ordering                                                                                                                                                                         | Replace on-demand aliases                   |
| -------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Brand                | None                                                                                            | Keep `check:integration`, `check:catalog` and `check:tokens`.                                                                                                                                                  | `fix`, `explore`                            |
| Admin                | `check:colours`, `check:copies`, `check:retired`, `check:elements`, `check:pages`               | Retired `["dist"]`, browser `test/pages`. Keep `check:fixture` before browser tests.                                                                                                                           | `fix`, `explore`                            |
| Slides               | `check:colours`, `check:copies`, `check:retired`, `check:elements`, `check:pages`               | Retired `["dist"]`, browser `test/pages`. Keep local `check:pins`.                                                                                                                                             | `fix`, `explore`                            |
| Documents            | `check:colours`, `check:copies`, `check:retired`, `check:elements`, `check:pages`               | Retired `["dist"]`, browser `test/pages`. Keep `check:privacy` after browser tests.                                                                                                                            | `fix`, `explore`                            |
| Mail                 | `check:colours`, `check:copies`, `check:retired`, `check:elements`, `check:modes`               | Retired `["dist"]`, browser `test/browser`. Keep `check:frames` between elements and retired.                                                                                                                  | `fix`, `explore`                            |
| Internal app         | `check:colours`, `check:copies`, `check:elements`, `check:links`                                | Elements via server `bun dist/server/entry.mjs` with `timeout: 120`, `stderr: true` and `linkSkips: ["/catalog"]`. Keep local retired. Drop `check:colours` and `check:copies` from the three `changed` lists. | `fix`, `explore`                            |
| Talks site           | `check:colours`, `check:copies`, `check:retired`, `check:links`, `check:pins`                   | Retired `["dist"]`. Server `exec bun --bun astro preview --host 127.0.0.1 --port "$PORT" --ignore-lock` and `linkSkips: ["/catalog"]`. Keep the local elements rebuild.                                        | `fix`, `explore`                            |
| Private slide site   | `check:colours`, `check:copies`, `check:retired`, `check:elements`, `check:links`, `check:pins` | Retired `["dist"]`. Server `cd talks && exec bun --bun run astro preview --ignore-lock --port "$PORT"`. Keep elements and density together.                                                                    | `fix`, `explore`                            |
| Website              | `check:colours`, `check:copies`, `check:retired`, `check:elements`                              | Retired `["dist"]`, elements via server `exec bun scripts/serve-dist-webkit.mjs`. Keep the local Linkinator crawl in its original group.                                                                       | `explore`. Keep the Oxlint-based `fix`.     |
| Practitioners        | `check:colours`, `check:copies`, `check:retired`, `check:elements`, `check:links`               | Retired `[".preview"]`. Server `exec astro preview --ignore-lock --outDir .preview --port "$PORT"`. Run `elements`, `retired` and `links` together after `check:preview`.                                      | `explore`                                   |
| Testimonials         | `check:colours`, `check:copies`, `check:retired`, `check:elements`, `check:links`               | `brand.directory: "site"`, retired `["site/dist"]`. Server `cd site && bun run astro preview --ignore-lock --host 127.0.0.1 --port "$PORT"`. Copies and retired still run at the root.                         | `fix`, `explore`                            |
| Certificate verifier | `check:colours`, `check:copies`                                                                 | Keep both local rendering checks. Retired reads `.site` and `node_modules/.cache/brand-pages`.                                                                                                                 | `fix`, `explore`                            |
| Trainer hub          | `check:colours`, `check:copies`, `check:elements`, `check:links`                                | Elements via server `bun dist/server/entry.mjs` and `linkSkips: ["/catalog"]`. Keep the local retired render. The slides pin enables `pins`.                                                                   | `fix`, `explore`                            |
| Training environment | None                                                                                            | No gate declaration.                                                                                                                                                                                           | `fix`                                       |
| Client app           | None                                                                                            | No gate declaration.                                                                                                                                                                                           | `explore`. Keep the project-specific `fix`. |

For each browser row, add `scaffolding.browserTest` and drop `scaffolding.test: "test"`.
Set `scripts.test` to `scaffolding test` to keep the direct fast suite. In docs and callers,
replace the deleted browser script with `bun --bun vitest run <folder>`.
The common `fix` alias becomes `bun run scaffolding fix` and the bare `explore` alias becomes
`bun run scaffolding-explore`. Leave `mutation` scripts in place. Some set
`SCAFFOLDING_MUTATION_BUN=1`, which changes the mutation runner.

**CSS origin.** In a repository's sources, a stylesheet from a company package comes only from
brand's `exports`; the shell's styles load only under `catalog/`; an engine's stylesheet loads where
the engine's `package.json` lists it in `scaffolding.styles`, the stylesheets its components render
with (`"styles": ["./styles/slides.css"]`); no other company package's CSS loads outside its own
repository. In a stylesheet, a path into `node_modules` names the file on disk and passes where an
`exports` entry targets it, a font or image under a `/*` export included.

**Installed paths.** Code, markup and data (every file `check-coupling` reads but stylesheets, Python
included, `package.json` with its scripts and tests included) name no path into `node_modules/` to a
company package, one under our scope or pinned to a Git repository hackersandwizards owns whatever its
name (`practitioners`), joined or as path segments: code takes a file through
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
an item of its list, that no longer matches anything. `check` names one of the checks that read the
list: `coupling`, `confidential`, `never-shown`, `structure` or `spaces`; any other fails the gate.

## Licences

The pinned `markdownlint-cli2` 0.24.2 package uses the MIT licence.

The shell step fetches the upstream GPL-3.0 ShellCheck v0.11.0 release for macOS and Linux on
arm64 and x86-64. It verifies the pinned SHA-256 before extracting the binary into
`node_modules/.cache/scaffolding/shellcheck/v0.11.0/` and runs it as a separate process.
The shipped package excludes the binary. An unsupported platform, failed download or
checksum mismatch fails the step.

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

Shipped exceptions, which may match nothing: `@hackersandwizards/*` (our own packages; one under
another name, such as `practitioners`, keeps an entry of its own with its reason) and sharp's
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
