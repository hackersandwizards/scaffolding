# The gate

`scaffolding check` runs `bun install --frozen-lockfile`, then the shared steps side by side, the
catalog build and lint once a typecheck that runs Astro has finished (it writes the content types the typed rules read):
format, lint (ESLint), oxlint, styles (stylelint), typecheck, structure, coupling, cycles, names, layers, shell, python, terraform, dockerfile, workflows, markdown, spaces, confidential, licenses, the tests, the catalog build (`bun run build`) and admin (the item files, with the pinned
`@hackersandwizards/admin`'s `admin-check`; a repository without admin pinned needs `skip.admin`). Once those pass, the full-gate groups run in order. A red group stops the groups after it. Format, lint and styles walk past every
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
`.oxlintrc.json`. Each path, pattern, and selector in an enabled `no-restricted-imports` or
`no-restricted-syntax` rule needs a non-blank `message` in the root rules and in overrides.
Use it to tell the reader where the import belongs or what to write instead.
`check-structure` also checks for legacy ESLint config filenames and compares the effective
rules on files both linters select, including Astro frontmatter and extracted client scripts. A rule enabled as a
warning or an error in both linters for the same code fails structure. The finding names the
file and both rule IDs. Adjust the local config so one linter owns the rule there. See
[Configs](configs.md) for the shared settings and [code design limits](configs.md#code-design).

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
The step starts from tracked JavaScript, TypeScript and Astro files and includes untracked files
of those types that Git does not ignore. It compiles those Astro files
before passing them to dependency-cruiser. Imports resolve using the root `tsconfig.json`'s path aliases. Each compiled client
script is a separate module from its component's server code. The check ignores imports TypeScript
erases, including `import type`. To fix a runtime cycle, move shared code into a module that
neither side imports back from. The step reads no allow list. Submodule cycles belong to their
own repositories.

**Names.** The `names` step reports each module-scope function name declared in more than one
production JavaScript or TypeScript file selected by Oxlint. It counts function declarations
and variables initialized with an arrow function or function expression. It skips tests,
declaration files, minified files, stories, submodules, and files under `dist`, `vendor`,
`node_modules`, or `public`. Framework entry points and verbatim skeleton files are exempt.
Each finding lists every file declaring the name. The guide follows the findings.

To exempt paths from `names`, add a `settings.scaffolding.names` object to the repository's
`.oxlintrc.json`. Map each repository-relative glob to a non-blank reason.

```json
{
  "settings": {
    "scaffolding": {
      "names": {
        "src/content/trainings/**/exercises/**": "The exercise starting state and solution copy declare the same functions by design."
      }
    }
  }
}
```

The step leaves matching files out of the name collection. It reports a shared name only when
two or more checked files declare it.

**Layers.** The `layers` step compares `docs/architecture/layers.md` with the generated map. Each Oxlint override
with an enabled `no-restricted-imports` rule contributes to a layer named for its file globs.
The map joins the normalized globs, dropping each trailing `/**`, and combines restrictions
under the same name. A path matches the glob with the longest literal prefix, subject to
`excludeFiles`. Ties favor fewer `**`, then more literal characters, counting the shortest
alternative in each brace group. If the globs still tie, the alphabetically first layer name wins.
Unmatched paths use their top-level folder, with
` (outside layers)` appended when needed for a unique label. Edge labels count imports between layers
using the runtime graph from `cycles`, including untracked sources that Git does not ignore.

Run `bun run scaffolding layers --write` to regenerate the map and commit it with the changes.
Delete the map when the last layer is removed.

**Shell.** ShellCheck reports findings at every severity in its inputs and follows sources
with `-x` for analysis. It checks tracked `.sh` and `.bash` files and files with
an sh, bash, dash or ksh shebang. Other scripting extensions, including TypeScript, JavaScript
and Python, take precedence over the shebang. The step skips symlinked scripts and unmerged index
entries. It uses the root `.shellcheckrc` when present and reports when there are no scripts.
Run `bun run scaffolding shell` to check shell scripts on demand. When there are findings, both the
gate and pre-commit output end the ShellCheck report with a reminder to repair each finding in the
script.

## Language and infrastructure linting

Each step checks tracked files and prints a no-input message if none match. Regular files under
`node_modules` and files inside submodules are outside the input set. The tools print rule names or
codes and the gate follows findings with a repair guide.

| Step         | Inputs and checks                                                                                                                               | Repository configuration                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `styles`     | Stylelint on CSS and Astro, with guides for the [shared base](configs.md).                                                                      | Root Stylelint configuration.                                                                                        |
| `python`     | Ruff lint and format checks on `*.py` and `*.pyi`, respecting exclusions.                                                                       | Root `.ruff.toml`, `ruff.toml`, or `[tool.ruff]` in `pyproject.toml`. Ruff defaults apply otherwise.                 |
| `terraform`  | Terraform format check with a diff on `*.tf` and `*.tfvars`. TFLint runs per directory with tracked `*.tf` files and reports at every severity. | Root `.tflint.hcl`, when present, also triggers plugin initialization. The default is the bundled Terraform ruleset. |
| `dockerfile` | Hadolint at every severity on `Dockerfile`, `Dockerfile.*`, `*.Dockerfile` and `Containerfile`, regardless of case.                             | Root `.hadolint.yaml` or `.hadolint.yml`.                                                                            |
| `workflows`  | actionlint with pinned ShellCheck on `.github/workflows/*.yml` and `*.yaml`. Pyflakes is disabled.                                              | `.github/actionlint.yaml` or `.github/actionlint.yml`.                                                               |

The workflows check adds `ubuntu-26.04` and `ubuntu-26.04-arm` to a temporary actionlint config that preserves any repository settings.

Run `bun run scaffolding <step>` on demand for `python`, `terraform`, `dockerfile` and
`workflows`. The gate and pre-push hook run all four where selected. Pre-commit continues to
run Stylelint on staged CSS and Astro. Ruff, Terraform, TFLint, Hadolint and actionlint run
with isolated user configuration and keep their default storage under
`node_modules/.cache/scaffolding/`. Set `scaffolding.skip.<step>` with a reason to skip a
gate step.

## Markdown

`bun run scaffolding markdown` checks all tracked `.md` files with
markdownlint-cli2. It skips symlinks, submodules and `node_modules`. The package supplies the rules,
including for repositories with local markdownlint configuration. Use
`bun run scaffolding markdown --fix` to apply markdownlint's fixes to the working tree. Findings
that require manual edits still fail the command. When there are findings, both the gate and
pre-commit output end the Markdown report with the fix command and a reminder to repair remaining
findings by changing only Markdown structure and preserving every word. The gate accepts
`scaffolding.skip.markdown` with a reason to skip the whole step.

Set `scaffolding.markdown.content` in `package.json` to an array of existing repository-relative
folders below the repository root, for example `["src/content", "articles"]`. Each literal path
applies to tracked Markdown in that folder and its descendants. Those files use the shared rules with
MD033, MD041, MD025, MD024 and MD036 disabled. Files outside the listed folders use the full set,
as do all files when the list is absent or empty. Invalid configuration fails the step.
Both fix commands use the same rules. File-level and inline overrides are disabled.

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
their content from the index. ShellCheck's snapshot also includes all tracked shell scripts,
the root `.shellcheckrc` and tracked files referenced by literal source commands or
`source=` directives. The snapshot follows those references recursively through index files.
The hook reads the corresponding `skip.shell` and `skip.markdown` reasons and the Markdown content
folders from the staged package manifest.

## Changed paths

`scaffolding check --changed` (`bun run check --changed`) always runs frozen install, then
each enabled step among format, structure, coupling, spaces, confidential, licenses, admin,
pins, colours and copies.
Paths are repository-relative. Matches are case-sensitive except for Dockerfile basenames. Every match adds its steps.

The gate sets `SCAFFOLDING_CHANGED` for each step. A value of `1` marks a changed check and `0`
marks a full check.

| Default paths                                                                                                         | Additional steps                                             |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `docs/architecture/layers.md`                                                                                         | layers                                                       |
| `**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts,astro,mdx}`                                                                      | typecheck, lint, oxlint, cycles, names, layers, test         |
| `**/*.{astro,mdx}`                                                                                                    | styles                                                       |
| `**/*.{css,scss,sass,less}`                                                                                           | styles, test                                                 |
| `{src,app,lib,bin,components,pages,catalog,site,talks,scripts,test,tests,fixtures,data,content,public,assets,e2e}/**` | typecheck, lint, oxlint, styles, cycles, names, layers, test |
| `**/*.md`                                                                                                             | markdown                                                     |
| `**/*.{sh,bash}`, `**/.shellcheckrc`, shell shebangs, tracked shell sources                                           | shell                                                        |
| `**/*.{py,pyi}`, root `ruff.toml`, `.ruff.toml`, `pyproject.toml`                                                     | python                                                       |
| `**/*.{tf,tfvars}`, root `.tflint.hcl`                                                                                | terraform                                                    |
| `Dockerfile`, `Dockerfile.*`, `*.Dockerfile`, `Containerfile` at any depth and case, root `.hadolint.{yaml,yml}`      | dockerfile                                                   |
| `.github/actionlint.{yaml,yml}`                                                                                       | workflows                                                    |
| `docs/**/*.txt`, `.claude/skills/**/*.{yaml,yml}`                                                                     | Always-run steps only                                        |

The shell and Markdown matches add their steps. A path covered only by those matches still
selects all enabled fast steps under the fallback, as does an unmatched path or a path below.

- `**/package.json`
- `**/{bun.lock,bun.lockb,package-lock.json,pnpm-lock.yaml,yarn.lock,bunfig.toml,.npmrc}`
- `**/{tsconfig*.json,eslint.config.*,oxlint.config.*,.oxlintrc*,prettier.config.*,.prettierrc*,.prettierignore,stylelint.config.*,.stylelintrc*,.stylelintignore,astro.config.*,vite.config.*,vitest.config.*,playwright*.config.*}`
- `.gitmodules`, `.githooks/**`, `.github/workflows/**`, `.gitlab-ci.yml`

The pre-push hook passes every pushed branch's range as `--changed <from>..<to>...`. The gate
unions the paths across ranges, including both paths of a rename and the old path of a deletion.
It reads shell shebangs and follows tracked shell source references at both ends of a pushed
range. A local changed check reads them in the base commit and the working tree.
A new branch, unreadable range, non-fast-forward update or failed Git enumeration selects all fast
steps and prints the reason. Without explicit ranges, the gate compares the working tree to the
upstream merge base, or to `HEAD` without an upstream, and includes untracked files. Each selected
step still checks the working tree. Shell and Markdown lint judge new files once they are staged,
even if an untracked path already selected the step. Astro lint also selects the enabled
typecheck that generates its content types and waits for it.

### package.json fields

`scaffolding.markdown.content` selects the folders that use the [Markdown content rules](#markdown).

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

**Output and load.** Each step prints its output and its `ok` or `FAIL` line with its duration when
it ends. A step killed by a signal on its own also prints `FAIL`. The last line names the red steps
in the gate's order. The gate forwards `SIGINT`, `SIGTERM`, `SIGHUP` and `SIGQUIT` to its steps.
On one of those gate interrupts, each interrupted step prints what it said so far and
`stopped <step> by <signal>`.

Where the one-minute load average is above the core count, the gate says so in its first line: the
quick shared checks still run side by side, then `test` and `catalog` one after another, and each
group of the repository's own steps at most cores × cores ÷ load at a time, at least 2. `SCAFFOLDING_LOAD=<n>` replaces the measured load. Load per core also stretches
`serve`'s default wait ([Configs](configs.md)), at most ten times, and sets `SCAFFOLDING_TEST_TIMEOUT_MS` for every
step: 5000 ms on an idle machine. bun takes a per-test limit only as a flag, so the repository's
test command passes it on, `"test": "bun test --timeout ${SCAFFOLDING_TEST_TIMEOUT_MS:-5000}"`;
vitest takes `--testTimeout=${SCAFFOLDING_TEST_TIMEOUT_MS:-5000}` or reads the variable in its
config. A test that sets its own timeout passes `limit(ms)` from
`@hackersandwizards/scaffolding/test-timeout` so its limit scales with the runner's default.
A fixed 30 s limit timed out under load where the default had stretched.
Without load scaling every test keeps its 5 s limit however loaded the machine is, so
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
alongside the shared static checks by default. Both run in every changed check, including an
empty push range. Put either name in `scaffolding.check` to run it in that group. A changed
check keeps the group order and defers the catalog build and other full-only steps.

`retired` and `elements` run in the full gate after the catalog build. Full shared steps
without an explicit position run side by side before the first local group. Put a shared name
in `scaffolding.check` at the point where it should run. Each top-level entry runs after the
previous entry finishes, and steps in an array run alongside one another. For example,
`["check:preview", ["retired", "links"], "check:elements"]` scans and crawls the preview
before the local elements step can rebuild it.
Use `scaffolding.brand.retired` to name the built paths to scan. `scaffolding.brand.directory`
sets the working directory for colours and elements, and retired paths stay relative to the
repository root. Set `scaffolding.brand.elements` to `"server"` to pass `--base {url}` through
`with-server`. The server starts from the repository root for both elements and links.
Declare the server once, with optional readiness timeout in seconds and stderr forwarding.

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

`links` in `scaffolding.check` enables the full-gate crawl and requires `scaffolding.server`.
Each server-backed check starts its own server with `PORT` and `HOST` set by `with-server`.
An elements-only consumer can declare the server and omit the `links` entry.
`scaffolding.linkSkips` lists optional path prefixes, such as `["/catalog"]`. The shared crawl
passes each as a separate `--skip` argument to `check-links`. Declare `linkSkips` only for a
shared crawl.

Put `links` after the build it should crawl, such as after `check:preview`.
A listed `check:links` keeps its local command and existing group.
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
`scaffolding-explore` selects Bun from `scaffolding.browserTest` even when the test script uses
the shared alias. `scaffolding-mutation` selects its runner through `SCAFFOLDING_MUTATION_BUN`.

### Migrating consumer manifests

Raise the scaffolding pin before using the new manifest keys. Remove the listed local scripts
and their `fullOnly` reasons. In `scaffolding.check`, replace each migrated full-gate step in
its original entry or array. Remove migrated fast steps that use the default position. To
keep colours and copies in their original group, replace the local names with `colours` and
`copies` in that group. Keep the other local
steps in their original groups. Move retired scan paths into `brand.retired` and server
commands into `server.command`. Set `brand.elements` to `"server"` when the shared elements
step needs the URL.

Both brand scanners list tracked and untracked files with
`git ls-files -z --cached --others --exclude-standard` in `scan/colours.ts`.
The `generated` exception excludes paths under `dist/`, `build/`, `.astro/` and
`node_modules/` at any depth. Colours checks that exception before scanning styling
files, and `scan/copies.ts` filters the same exception before checking for copies.
Moving the scans before a build that writes only to those directories preserves their
verdict. An untracked build folder with a custom name outside those exclusions enters
the scan if Git does not ignore it. Keep both scans in their original group when they
need to see those files.

| Consumer             | Remove local scripts                                                                            | Declarations and full-gate order                                                                                                                                                                                                                                                                                                                                                                                                                 | On-demand aliases to remove or keep                                                  | Lines to update in the same commit                                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brand                | None                                                                                            | Order unchanged. Keep `check:integration`, `check:catalog` and `check:tokens`.                                                                                                                                                                                                                                                                                                                                                                   | Remove `fix`, `explore`.                                                             | `CLAUDE.md:100,105`, `README.md:85`.                                                                                                                                         |
| Admin                | `check:colours`, `check:copies`, `check:pages`, `check:elements`, `check:retired`               | Colours and copies move to the shared static phase. Keep `check:scan`. After `check:fixture`, run `browser-test` (`test/pages`), `elements`, then `retired` (`["dist"]`).                                                                                                                                                                                                                                                                        | Remove `fix`, `explore`.                                                             | `CLAUDE.md:53,61,62,64`, `README.md:62,63`.                                                                                                                                  |
| Slides               | `check:colours`, `check:copies`, `check:retired`, `check:pages`, `check:elements`               | Colours and copies move to the shared static phase. Keep `["check:pins", "retired"]` (`["dist"]`), then `browser-test` (`test/pages`), then `elements`.                                                                                                                                                                                                                                                                                          | Remove `fix`, `explore`.                                                             | `CLAUDE.md:141,142,144,152`, `README.md:68`, `test/pages/print-catalog.test.ts:7` (update the comment to name `browser-test`).                                               |
| Documents            | `check:colours`, `check:copies`, `check:pages`, `check:retired`, `check:elements`               | Colours and copies move to the shared static phase. Run `browser-test` (`test/pages`), `check:privacy`, `retired` (`["dist"]`), then `elements`.                                                                                                                                                                                                                                                                                                 | Remove `fix`, `explore`.                                                             | `CLAUDE.md:150,152,153,165,168,169`, `README.md:81,82`.                                                                                                                      |
| Mail                 | `check:colours`, `check:copies`, `check:modes`, `check:elements`, `check:retired`               | Colours and copies can use the shared static phase with the same verdict because both exclude the catalog's `dist/` and the build caches. To retain their position, replace the local entries with `colours` and `copies` in the same group. Run `browser-test` (`test/browser`), `elements`, `check:frames`, then `retired` (`["dist"]`).                                                                                                       | Remove `fix`, `explore`.                                                             | `CLAUDE.md:44,51`, `README.md:58,59,60,61`.                                                                                                                                  |
| Internal app         | `check:colours`, `check:copies`, `check:elements`, `check:links`                                | Colours and copies move to the shared static phase. Keep local `check:scan` and `check:retired` in the middle group. Set `brand.elements` to `"server"` and place `elements` and `links` in the last group. Server `bun dist/server/entry.mjs` with `timeout: 120`, `stderr: true`, and `linkSkips: ["/catalog"]`. Update the three changed mappings below.                                                                                      | Remove `fix`, `explore`.                                                             | `CLAUDE.md:16`, `README.md:79`, `.claude/rules/ui-conventions.md:55`, `src/lib/__tests__/gate-changed-map.test.ts:7` (set `SCANS` to `["colours", "copies", "check:scan"]`). |
| Talks site           | `check:pins`, `check:colours`, `check:copies`, `check:retired`, `check:links`                   | Pins, colours and copies move to the shared static phase. Keep `["retired", "check:usage"]` (`["dist"]`), then `links`, `check:density`, and local `check:elements`. The last step rebuilds with `CATALOG_FILE=1`. Server `exec bun --bun astro preview --host 127.0.0.1 --port "$PORT" --ignore-lock` and `linkSkips: ["/catalog"]`.                                                                                                            | Remove `fix`, `explore`.                                                             | `CLAUDE.md:33,39,40,41,42,45,62`, `README.md:49,50`.                                                                                                                         |
| Private slide site   | `check:pins`, `check:colours`, `check:copies`, `check:retired`, `check:links`, `check:elements` | Pins, colours and copies move to the shared static phase. Keep `["retired", "links", "check:usage"]` (`["dist"]`) before `["check:density", "elements"]`. Server `cd talks && exec bun --bun run astro preview --ignore-lock --port "$PORT"`.                                                                                                                                                                                                    | Remove `fix`, `explore`.                                                             | `talks/README.md:34,36`.                                                                                                                                                     |
| Website              | `check:colours`, `check:copies`, `check:elements`, `check:retired`                              | Colours and copies move to the shared static phase. Keep the local `check:links` in its original group. Set `brand.elements` to `"server"`. Run `elements` via `exec bun scripts/serve-dist-webkit.mjs`, then `retired` (`["dist"]`), ahead of records and content.                                                                                                                                                                              | Remove `explore`. Keep `fix`, which runs Oxlint first and uses its own ESLint flags. | `CONTRIBUTING.md:28,101`, `README.md:47,48`.                                                                                                                                 |
| Practitioners        | `check:colours`, `check:copies`, `check:elements`, `check:retired`, `check:links`               | Colours and copies move to the shared static phase. Keep `check:preview` before `["elements", "retired", "links"]`. Scan `[".preview"]` for retired lines. Server `exec astro preview --ignore-lock --outDir .preview --port "$PORT"`.                                                                                                                                                                                                           | Remove `explore`.                                                                    | `.githooks/README.md:15`, `README.md:39,40,43`.                                                                                                                              |
| Testimonials         | `check:colours`, `check:copies`, `check:elements`, `check:retired`, `check:links`               | Colours and copies can use the shared static phase with the same verdict because both exclude `site/dist/` and the build caches. To retain their position, replace the local entries with `colours` and `copies` in the same group. Keep `["elements", "retired", "links"]` together. Set `brand.directory: "site"` and `brand.retired: ["site/dist"]`. Server `cd site && bun run astro preview --ignore-lock --host 127.0.0.1 --port "$PORT"`. | Remove `fix`, `explore`.                                                             | `CLAUDE.md:42,50`, `README.md:76`.                                                                                                                                           |
| Certificate verifier | `check:colours`, `check:copies`                                                                 | Colours and copies move ahead of `check:deploy`. Keep local `check:elements` and then local `check:retired`, each with its `bun scripts/brand/pages.ts` prebuild. Retired reads `.site` and `node_modules/.cache/brand-pages`. Omit `links`.                                                                                                                                                                                                     | Remove `fix`, `explore`.                                                             | `CLAUDE.md:24`, `README.md:53,54`.                                                                                                                                           |
| Trainer hub          | `check:colours`, `check:copies`, `check:elements`, `check:links`                                | Colours and copies move to the shared static phase and the slides pin enables `pins`. Set `brand.elements` to `"server"`. After the first local group, run `links`, local `check:retired`, `check:a11y`, `check:density`, then `elements`. Server `bun dist/server/entry.mjs` and `linkSkips: ["/catalog"]`.                                                                                                                                     | Remove `fix`, `explore`.                                                             | `CLAUDE.md:29,33`, `README.md:33,34,37,38`.                                                                                                                                  |
| Training environment | None                                                                                            | Order unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                 | Remove `fix`.                                                                        | `justfile:2`.                                                                                                                                                                |
| Client PoC           | None                                                                                            | Order unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                 | Remove `explore`. Keep `fix`, which runs the project’s `lint:fix` and then Prettier. | `CONTRIBUTING.md:61,62`.                                                                                                                                                     |

The order changes in the table are relative to the old full gate. In each row that moves
fast checks, the ordering of the remaining local and migrated full-gate checks is preserved.

The internal app maps `docs/**`, `.claude/**` and `src/content/**` to `check:colours`,
`check:copies` and `check:scan` today. In **each** of those lists, replace
`check:colours` with `colours` and `check:copies` with `copies`. Keep `check:scan` in all
three lists and keep its script and check entry. The same three globs still select
`check:scan`, including for Markdown. The shared colours and copies scans run on every
changed check. Both scanners still run from the repository root.

For each browser row, set `scaffolding.browserTest` to the table's folder, drop
`scaffolding.test: "test"` and set `scripts.test` to `scaffolding test`. Both the fast test
suite and property exploration stay on Bun for all four browser rows. Replace on-demand
invocations of the deleted browser scripts with `bun --bun vitest run <folder>`.
In gate descriptions, use the shared step names. For direct invocations of deleted elements
or links scripts, use the corresponding bin with the same build, server and flags.
Replace the removed `fix` and `explore` invocations with `bun run scaffolding fix` and
`bun run scaffolding-explore`, respectively. Keep the existing `mutation` scripts.

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

The gate downloads pinned upstream binaries on demand for macOS and Linux on arm64 and x86-64.
It verifies both the release asset and the binary against their pinned SHA-256 values, stores the
binary under `node_modules/.cache/scaffolding/<tool>/<release>/` and runs it as a separate
process. The published package excludes the binaries. An unsupported platform, failed download or
checksum mismatch fails the step.

| Tool       | Release | Licence  |
| ---------- | ------- | -------- |
| ShellCheck | v0.11.0 | GPL-3.0  |
| Ruff       | 0.17.6  | MIT      |
| TFLint     | v0.66.0 | MPL-2.0  |
| Terraform  | 1.17.2  | BUSL-1.1 |
| Hadolint   | v2.15.1 | GPL-3.0  |
| actionlint | v1.7.12 | MIT      |

The `stylelint-config-recommended` 19.1.0 package uses the MIT licence.

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
