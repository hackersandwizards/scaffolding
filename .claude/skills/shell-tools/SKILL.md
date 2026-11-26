---
name: shell-tools
description: >-
  The zsh traps of the Bash tool and the preferred CLI tools on this machine. Load before the first
  Bash command of a run, again after the context is compacted, and for scripts that must run on
  macOS and Linux.
---

# Shell tools

Prefer `fd` (`bfs` for `find` syntax), `rg` (`ugrep` inside archives, compressed files and PDFs), `xh`, `jaq`, `pandoc`, `scrapling extract get <url> out.md`, `gh`, `glab`, `git-filter-repo`, `just`, `parallel`, `uv`, `uvx`, `pipx`, `bun` and `bunx` (`bun install -g` for globals), and the built-in `Bun.Image` over their classic equivalents.

**GNU vs BSD:** unprefixed CLI tools are BSD on macOS, GNU on Linux. Write scripts to run on both (POSIX, no flavor-specific flags). GNU builds are `g*` (`gsed`, `gdate`, `gtimeout`).

**Text and file navigation:**

- In a Bash-tool pipeline or script write
  `command ls`, `command cat` and `command grep`: the shell snapshot aliases the first two, which can
  block on stdin, and wraps `grep` in a function that has kept a line `grep -v` should drop. Prove a
  filter a safeguard rests on with a control: `diff` shows exactly the dropped line.
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

**HTTP and data:**

- `xh` reads a non-terminal stdin as the request body and waits for it to close, past `--timeout` (12 s with stdin held open, 0 s with the flag): pass `--ignore-stdin` in a script or tool call. `-q` prints nothing, the body included: a loop
  polling a page through `grep` reads it with `-b`.

**Git and code-host:**

- Before calling a repository setting one only the person can
  change, read the permission the API returns (`permissions.admin` in `gh api repos/<org>/<repo>`):
  after the person's decision, the change is yours.
- `git log --since=<date>` without a time reads that date at the current clock time, so a same-day
  window returns nothing: write `--since='<date> 00:00'`.

**System and shell:**

- Wait on a background job by its PID (`until ! kill -0 <pid>; do sleep 5; done`, run inside
  `Monitor` or a background command, since a foreground `sleep` loop is blocked) or a sentinel
  file, never `until ! pgrep -f <pattern>`: the loop's own shell command line contains the pattern, so
  pgrep always matches it and the wait never ends.
- Where Docker runs on OrbStack and a run needs it, start it with `orb start` and say so, without
  asking; stop it only where your run started it and nothing else uses it.

**JavaScript/TypeScript:**

- bun is the package manager in every repository of ours: `bun install`, `bun run`, `bun.lock`,
  `"packageManager": "bun@<version>"`, and those lines in its README and CLAUDE.md. A participant
  repository, a training repository without our `CLAUDE.md` at its root that participants build in
  the training, uses npm and node instead, in commands, lockfile, `packageManager`, README and MCP config, because most participants have no bun.
- A bun script outside a project resolves a bare import (`import sharp from "sharp"`) from its own
  folder, finds no `node_modules` and auto-installs, which can hang with no output and no CPU. Run
  it with `bun --no-install` and import the project's package by the absolute path of the file its
  `exports` names (`<project>/node_modules/sharp/dist/index.mjs`): a miss then fails at once.

**Media:**

- `transcribe [-l lang] [-o outdir] file...` for speech-to-text, never `whisper-cli` directly, which
  at its defaults invents repeated sentences. Install or propose no other model. Names come from
  records, never from the transcript.

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
long pathspec. Split with `${=list}`. A heredoc with an unquoted delimiter expands `$var` as the
file is written, and an unset one writes an empty string with no error: write a file that holds
paths through a quoted delimiter (`<<'EOF'`) and pass each value in as an argument.
