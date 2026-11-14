---
name: shell-tools
description: >-
  The zsh traps of the Bash tool (a bare `=word`, an unmatched glob, a function named like an alias),
  preferred CLI tools on this machine and the GNU/BSD portability rule. Load before the first Bash
  command of a run and again after the context is compacted, and for scripts that must run on
  macOS and Linux.
---

# Shell tools

Prefer these over their classic equivalents.

**Browser and frontend:**
- For rendered-page, frontend, or signed-in UI checks, try in order until one works: in-app Browser, Chrome DevTools MCP, repository automation (e.g. Playwright). Before skipping Chrome DevTools, search deferred tools (`ToolSearch` or equivalent) and check the repository for automation.
- Headless Chrome from the command line lays a page out at least 500 px wide: `--window-size=375,…` with `--screenshot` cuts a 500 px layout to 375, which looks like text overflowing the right edge. Set a phone width through CDP instead (`page.setViewport`, or the chrome-devtools MCP's `resize_page`).
- `playwright install` deletes every build in the shared Playwright cache that no installation
  registered in its `.links/` folder needs. List the cache before and after; restore a build that
  vanished with `node node_modules/playwright-core/cli.js install <browser>` in the repository that
  needs it, which also registers it. Install every browser the `playwright.config` projects name,
  and `launch()` each from the repository's own `node_modules` before a gate.

**GNU vs BSD:** unprefixed CLI tools are BSD on macOS, GNU on Linux. Write scripts to run on both (POSIX, no flavor-specific flags). GNU builds are `g*` (`gsed`, `gdate`, `gtimeout`).

**Text and file navigation:**
- `eza` over `ls`, `bat` over `cat` and `less` when typing. In a Bash-tool pipeline or script write
  `command ls`, `command cat` and `command grep`: the shell snapshot aliases the first two, which can
  block on stdin, and wraps `grep` in a function that has kept a line `grep -v` should drop. Prove a
  filter a safeguard rests on with a control: `diff` shows exactly the dropped line.
- `fd` over `find` for terse search; `bfs` when `find` syntax is needed
- `rg` over `grep` for code search; `ugrep` for searching inside archives, compressed files, or PDFs
- `rg` recurses by default. Never pass `-r`: it is `--replace` and silently rewrites output. Write `rg -il`, never `rg -ril`.
- A pattern starting with `-` reads as flags; pass it as `grep -F -e '-de-DE' f`. The error goes to
  stderr, so a run discarding stderr and testing only for empty output reads the failure as zero hits.
- `jq`'s `strftime` renders UTC, while `date` renders local time. Bucketing an epoch timestamp
  into a day through `jq` puts everything before local 02:00 on the previous day.
- `rg` skips dot-directories, so `rg <pattern> .` reports zero hits across every skill, rule, agent and memory under `.claude/`. Pass `--hidden`, name the directory, or use `git grep`. A "no references remain" sweep run without it cannot fail.
- `rg` with no path argument searches stdin wherever stdin is a pipe or a file, a tool call included, and hangs until the timeout, leaving an empty result file that reads as zero hits. Pass a path (`.`) and `</dev/null`. An `rg` meant to filter a pipe keeps its stdin: `</dev/null` there replaces the pipe and also reads as zero hits. It also skips binary files, so count PDFs by file name with `git ls-files` or `fd`.
- Judge a content-search hit by its matching line (`rg -n`), never by its file's name: a topic's
  page often sits as a link line inside a hub page. Search the user's words and their synonyms
  before leaving the repository.
- `delta` for diffs, `tree` for directory tree, `fzf` for fuzzy selection
- `zoxide` for directory jumping (`z <pattern>`)

**HTTP and data:**
- `xh` over `curl` and `httpie`. `xh` reads a non-terminal stdin as the request body and waits for it to close, past `--timeout` (12 s with stdin held open, 0 s with the flag): pass `--ignore-stdin` in a script or tool call. `-q` prints nothing, the body included: a loop
  polling a page through `grep` reads it with `-b`.
- `jaq` over `jq`, `pandoc` for document conversion
- `scrapling` to scrape web pages to markdown (`scrapling extract get <url> out.md`)

**Git and code-host:**
- `gh` for GitHub, `glab` for GitLab. Before calling a repository setting one only the person can
  change, read the permission the API returns (`permissions.admin` in `gh api repos/<org>/<repo>`):
  after the person's decision, the change is yours.
- A push after a directory rename can pack every renamed blob again (git's sparse walk compares only changed paths): 491 objects and 39 MB for 66 new ones, which GitLab let hang. Push it with `git -c pack.useSparse=false push`.
- `git log --since=<date>` without a time reads that date at the current clock time, so a same-day
  window returns nothing: write `--since='<date> 00:00'`.
- A pipeline exits with its last command's status: `git push ... | tail -2 && git tag vX` tags after
  a rejected push. Chain on the push itself and tag only once `git rev-parse HEAD` equals
  `origin/main`. A tag that landed off main stays put: merge `origin/main` into the tagged commit.
- `lazygit` for git TUI, `git-filter-repo` for history rewrites
- Global git aliases from `~/.gitconfig` that add workflow behavior:
  - `git all <args...>` -> run `git <args...>` in every repository under the current tree
  - `git integrate <branch>` -> merge a branch with `--no-ff --edit` after confirming `HEAD` is up to date with that branch

**System and shell:**
- `btop` over `htop`, `watch` for repeated commands
- Wait on a background job by its PID (`until ! kill -0 <pid>; do sleep 5; done`, run inside
  `Monitor` or a background command, since a foreground `sleep` loop is blocked) or a sentinel
  file, never `until ! pgrep -f <pattern>`: the loop's own shell command line contains the pattern, so
  pgrep always matches it and the wait never ends.
- `just` as command runner, `parallel` for fan-out
- Where Docker runs on OrbStack and a run needs it, start it with `orb start` and say so, without
  asking; stop it only where your run started it and nothing else uses it.
- `cdxe` to start Codex exec. It is aliased to `codex exec --yolo`: no approvals, no sandbox.

**JavaScript/TypeScript:**
- bun is the package manager in every repository of ours: `bun install`, `bun run`, `bun.lock`,
  `"packageManager": "bun@<version>"`, and those lines in its README and CLAUDE.md. A participant
  repository, a training repository without our `CLAUDE.md` at its root that participants build in
  the training, uses npm and node instead, in commands, lockfile, `packageManager`, README and MCP config, because most participants have no bun.
- A bun script outside a project resolves a bare import (`import sharp from "sharp"`) from its own
  folder, finds no `node_modules` and auto-installs, which can hang with no output and no CPU. Run
  it with `bun --no-install` and import the project's package by the absolute path of the file its
  `exports` names (`<project>/node_modules/sharp/dist/index.mjs`): a miss then fails at once.
- `bun` instead of `node` for running scripts, and `bunx` instead of `npx` for a package the project
  does not install, outside a participant repository
- `bun install -g` for globals at `~/.bun/bin`
- built-in `Bun.Image` for image processing (Sharp-shaped, JPEG/PNG/WebP/HEIC/AVIF, no npm deps)

**Media:**
- `transcribe [-l lang] [-o outdir] file...` for speech-to-text, never `whisper-cli` directly, which
  at its defaults invents repeated sentences. Install or propose no other model. Names come from
  records, never from the transcript.

**Python:**
- `uv` for project envs and dependencies
- `uvx` for running tools without installing
- `pipx` for persistent CLI installs

Environment: macOS (darwin), Homebrew, zsh, Ghostty terminal.

The Bash tool runs zsh. A bare word starting with `=` (`echo =====`) is a failed command lookup that
drops the rest of the command line, and `:r` right after a variable is a modifier (`$sha:refs/...`
loses its `r`). Quote separators and write `${var}:`. An unmatched glob fails its own command with
`no matches found`: quote every glob a command receives as an argument (`--include='*.ts'`), and
list files with `command ls <dir> | command grep` rather than a bare pattern that may match
nothing. A function named like an alias of the shell snapshot (`g`, `c`, `t`) fails to parse
with `defining function based on alias`, and one named `G`, a global alias for `| grep`, fails with
`parse error near '|'`: give a function a name no alias holds.
`path`, `fpath`, `cdpath` and `manpath` are tied to their uppercase variables, so a loop variable
named `path` empties the search path and every later command fails with `command not found`. An
unquoted `$list` stays one word: `for x in $list` runs once and `git commit -- $files` passes one
long pathspec. Split with `${=list}`.
