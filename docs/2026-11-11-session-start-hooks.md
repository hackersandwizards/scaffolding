# Three session-start hooks, measured

Measured on 11.11.2026 for a decision between three session-start hooks. This report gives the
numbers and recommends nothing.

## The three hooks

| Hook                                          | At a session start                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A, fast-forward**                           | `git fetch -q origin main` with no time limit, `git merge --ff-only -q origin/main`, then `bun install --frozen-lockfile` without the lock. A failed fetch or merge prints one line on stdout; git's own error goes to stderr, which Claude Code does not show the session.        |
| **B, skeleton (v5.16.0)**                     | `.githooks/session-start`: fetches `main` within 20 s, moves no branch, prints how many commits `origin/main` is ahead, then runs `.githooks/install`, which installs under the lock and skips the install at once while another command (a gate, a build) holds it.               |
| **C, fast-forward, locked install (v5.17.2)** | Hook A's fetch, switch, merge and both `\|\| echo` lines, with `bun install --frozen-lockfile` replaced by `.githooks/install`, the skeleton's locked install, which skips at once while another command holds the lock. A skipped install prints hook A's install line on stdout. |

A and B ran with the git hooks of scaffolding v5.16.0. So after hook A's fast-forward changed
`bun.lock`, the `post-merge` hook first ran the locked install (skipped while a gate held the lock)
and then hook A ran its own plain install.

## Setup

- **Consumer.** A scratch clone of the documents repository at v1.27.2: 517 packages in
  `bun.lock`, 432 installed. Its `origin` was a local bare repository. bun 1.4.4 on macOS (APFS).
- **Start and ahead.** Every round started from commit D (eslint 10.13.0, prettier 3.9.9, astro
  7.4.6), installed and clean, with `refs/remotes/origin/main` at D. `origin/main` was one commit
  ahead: S changes four source and text files and leaves `bun.lock` alone; U returns eslint,
  prettier and astro to 10.14.0, 3.9.10 and 7.4.7, which changes 17 package entries in `bun.lock`.
  The gate alone was green at D, at S and at U.
- **Gate.** `bun run check` (install, the shared steps, typecheck, the catalog build, the tests,
  brand's checks), 136 to 194 s a run. Every gate ran with `SCAFFOLDING_TEST_TIMEOUT_MS=30000`: at
  the default 5 s the first baseline went red on a test hook timeout at a load of 70.
- **Starts.** The hooks ran as Claude Code runs a command hook (`sh -c`, from the checkout), their
  stdout and stderr kept apart. In the rounds with a gate they started 1, 3, 6, 10, 20, 40, 60, 80,
  100 or 125 s into it, the same ten offsets for every hook, A and B alternating round by round, C's
  rounds run after theirs.
- **Readings.** A package is _stale_ where `node_modules` holds it at another version than the
  `bun.lock` of `HEAD` says, _missing_ where a clean install has it and it is gone. Load is the
  one-minute load average when the hooks started; seven other jobs ran on the machine.
- **Larger consumer.** A scratch clone of a private repository with about 700 installed packages
  (806 entries in `bun.lock`), its ahead commit changing two packages, measured without a gate.
- **Hook C.** Measured later the same day, in a setup rebuilt from the same commits and steps: D,
  S and U made again, U changing the same 17 entries, the stale reader counting 429 installed of the
  518 entries in D's `bun.lock`. C ran with the git
  hooks of scaffolding v5.17.2, the release a consumer has today; the rows of A and B stay as
  measured with v5.16.0. The documents gate at v5.16.0 requires `.githooks` to equal its own
  template, so the v5.17.2 hooks ran from a copy outside the checkout: git took `core.hooksPath`
  from the environment of C's processes only, and C's command called that copy's `install`. The
  gate held its lock with its own v5.16.0 `check-lock`.

Controls, each a round that must give a non-zero reading:

- A fast-forward to U with the install held back read 7 stale packages.
- astro removed 1 s into a gate turned it red in 2 s, typecheck and catalog naming the missing
  module.
- A first gate control, which removed eslint 3 s in, missed: lint finishes 0.4 s into the gate.
  That gate went red on a test timeout instead.

The same controls in the setup rebuilt for hook C:

- The fast-forward to U with the install held back read 7 stale packages.
- astro removed 1 s into a gate turned it red in 1 s, typecheck and catalog naming the missing
  module.
- Hook C started 10 s into a gate at U skipped its install behind the gate's lock, `[check-lock]`
  naming the holder on stderr and hook A's install line on stdout, and left 7 packages stale once
  the gate ended green.
- The gate alone was green at S and at U. At D it went red at a load of 52 on a test timeout, a
  Chrome probe taking 33 s, and was green when run again at 39.

## Results

Rounds with one session and no gate, 10 rounds per row, documents unless the case says larger
consumer:

| Case                                        | Hook | HEAD at `origin/main` | Edit kept | Start median / max                                         | Load      | The session reads (stdout)                 |
| ------------------------------------------- | ---- | --------------------- | --------- | ---------------------------------------------------------- | --------- | ------------------------------------------ |
| Behind, `bun.lock` changed (U)              | A    | 10/10, nothing stale  |           | 300 ms / 367 ms                                            | 9.0–9.5   | nothing                                    |
|                                             | B    | 0/10                  |           | 165 ms / 350 ms                                            | 9.0–9.5   | "origin/main is 1 commits ahead" 10/10     |
|                                             | C    | 10/10, nothing stale  |           | 364 ms / 426 ms                                            | 24.3–25.0 | nothing                                    |
| Behind, `bun.lock` unchanged (S)            | A    | 10/10, nothing stale  |           | 112 ms / 152 ms                                            | 8.4–9.1   | nothing                                    |
|                                             | B    | 0/10                  |           | 147 ms / 158 ms                                            | 8.4–9.1   | "ahead" 10/10                              |
|                                             | C    | 10/10, nothing stale  |           | 165 ms / 180 ms                                            | 25.1      | nothing                                    |
| Behind, larger consumer                     | A    | 10/10, nothing stale  |           | 279 ms / 676 ms                                            | 5.2–5.5   | nothing                                    |
|                                             | B    | 0/10                  |           | 191 ms / 342 ms                                            | 5.2–5.5   | "ahead" 10/10                              |
|                                             | C    | 10/10, nothing stale  |           | 337 ms / 380 ms                                            | 14.7–15.8 | nothing                                    |
| Uncommitted edit in a file S changes        | A    | 0/10                  | 10/10     | 91 ms / 96 ms                                              | 7.3–8.4   | "not merged" 10/10; git's reason on stderr |
|                                             | B    | 0/10                  | 10/10     | 141 ms / 145 ms                                            | 7.3–7.8   | "ahead" 10/10                              |
|                                             | C    | 0/10                  | 10/10     | 140 ms / 154 ms                                            | 25.1–25.2 | "not merged" 10/10; git's reason on stderr |
| Uncommitted edit in `package.json`, U ahead | A    | 0/10                  | 10/10     | 89 ms / 116 ms                                             | 6.9–7.3   | "not merged" 10/10; git's reason on stderr |
|                                             | B    | 0/10                  | 10/10     | 142 ms / 163 ms                                            | 6.9–7.3   | "ahead" 10/10                              |
|                                             | C    | 0/10                  | 10/10     | 150 ms / 185 ms                                            | 24.8–25.2 | "not merged" 10/10; git's reason on stderr |
| Uncommitted edit in a file S leaves alone   | A    | 10/10                 | 10/10     | 110 ms / 122 ms                                            | 6.5–6.9   | nothing                                    |
|                                             | B    | 0/10                  | 10/10     | 144 ms / 161 ms                                            | 6.5–6.9   | "ahead" 10/10                              |
|                                             | C    | 10/10                 | 10/10     | 169 ms / 185 ms                                            | 24.3–24.8 | nothing                                    |
| GitHub's name does not resolve              | A    | 0/10                  |           | 75 ms / 426 ms                                             | 5.8–6.3   | "not merged" 10/10                         |
|                                             | B    | 0/10                  |           | 126 ms / 149 ms                                            | 5.8–6.3   | "fetch failed" 10/10                       |
|                                             | C    | 0/10                  |           | 126 ms / 349 ms                                            | 24.3      | "not merged" 10/10                         |
| SSH connects and never answers              | A    | 0/10                  |           | still running at 120 s, when the harness stopped it, 10/10 | 7.2       | nothing                                    |
|                                             | B    | 0/10                  |           | 21 s / 21 s                                                | 22.2      | "not fetched within 20 s" 10/10            |
|                                             | C    | 0/10                  |           | still running at 120 s, when the harness stopped it, 10/10 | 19.1      | nothing                                    |

Several sessions starting at once while a gate runs, 10 rounds per row, documents. "Gate red" is
the gate's first run in that round, with the cause read from its log. Sessions' messages are summed
over the rounds, n per round. "install failed" is hook A's install line, which hook C prints on stdout
when its install skips behind the gate's lock; `[check-lock]` names the holder on stderr.

| `bun.lock` | n   | Hook | Gate red                                                                                                              | Stale after       | HEAD at `origin/main` | Start median / max | Load      | The sessions read                                             |
| ---------- | --- | ---- | --------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------- | ------------------ | --------- | ------------------------------------------------------------- |
| changed    | 2   | A    | 3/10, a module missing                                                                                                | 0/10              | 10/10                 | 280 ms / 1.5 s     | 5.4–13.6  | "not merged" 10 of 20, git's "cannot lock ref" on stderr      |
| changed    | 2   | B    | 0/10                                                                                                                  | 0/10              | 0/10                  | 135 ms / 156 ms    | 5.2–19.9  | "fetch failed" 10, "ahead" 10, "install did not run" 20 of 20 |
| changed    | 2   | C    | 2/10: a test timeout, green when run again; Chrome exited 2 while printing, red again when run again at a load of 113 | 10/10, 7 packages | 10/10                 | 205 ms / 578 ms    | 15.0–87.0 | "not merged" 10, "install failed" 20 of 20                    |
| changed    | 4   | A    | 2/10, a module missing                                                                                                | 0/10              | 10/10                 | 240 ms / 764 ms    | 5.9–30.0  | "not merged" 30 of 40                                         |
| changed    | 4   | B    | 0/10                                                                                                                  | 0/10              | 0/10                  | 148 ms / 230 ms    | 7.1–36.6  | "fetch failed" 30, "ahead" 10, "install did not run" 40 of 40 |
| changed    | 4   | C    | 0/10                                                                                                                  | 10/10, 7 packages | 10/10                 | 167 ms / 701 ms    | 16.9–82.7 | "not merged" 30, "install failed" 40 of 40                    |
| changed    | 8   | A    | 3/10, a module missing                                                                                                | 1/10, 14 packages | 10/10                 | 250 ms / 2.6 s     | 6.2–59.1  | "not merged" 70 of 80                                         |
| changed    | 8   | B    | 0/10                                                                                                                  | 0/10              | 0/10                  | 147 ms / 237 ms    | 6.6–34.6  | "fetch failed" 68, "ahead" 12, "install did not run" 80 of 80 |
| changed    | 8   | C    | 3/10, Chrome exited 2 while printing, green when run again                                                            | 10/10, 7 packages | 10/10                 | 178 ms / 2.1 s     | 15.8–74.8 | "not merged" 62, "install failed" 80 of 80                    |
| unchanged  | 2   | A    | 0/10                                                                                                                  | 0/10              | 10/10                 | 146 ms / 373 ms    | 6.0–25.3  | "not merged" 10 of 20                                         |
| unchanged  | 2   | B    | 0/10                                                                                                                  | 0/10              | 0/10                  | 148 ms / 289 ms    | 6.8–13.3  | "fetch failed" 10, "ahead" 10, "install did not run" 20 of 20 |
| unchanged  | 2   | C    | 1/10, Chrome exited 2 while printing, green when run again                                                            | 0/10              | 10/10                 | 139 ms / 351 ms    | 20.8–59.0 | "not merged" 10, "install failed" 20 of 20                    |
| unchanged  | 4   | A    | 1/10, a test timeout, green when run again                                                                            | 0/10              | 10/10                 | 128 ms / 230 ms    | 7.5–16.5  | "not merged" 30 of 40                                         |
| unchanged  | 4   | B    | 0/10                                                                                                                  | 0/10              | 0/10                  | 144 ms / 1.9 s     | 6.9–22.1  | "fetch failed" 30, "ahead" 10, "install did not run" 40 of 40 |
| unchanged  | 4   | C    | 0/10                                                                                                                  | 0/10              | 10/10                 | 160 ms / 1.7 s     | 14.0–64.1 | "not merged" 30, "install failed" 40 of 40                    |
| unchanged  | 8   | A    | 0/10                                                                                                                  | 0/10              | 10/10                 | 191 ms / 257 ms    | 6.1–24.3  | "not merged" 67 of 80                                         |
| unchanged  | 8   | B    | 1/10, a Chrome print timeout, green when run again                                                                    | 0/10              | 0/10                  | 169 ms / 306 ms    | 9.2–24.6  | "fetch failed" 70, "ahead" 10, "install did not run" 80 of 80 |
| unchanged  | 8   | C    | 0/10                                                                                                                  | 0/10              | 10/10                 | 133 ms / 1.1 s     | 12.8–34.8 | "not merged" 70, "install failed" 80 of 80                    |

Hook A's red gates came 1 or 3 s into the gate in five rounds, when its install met typecheck or
the catalog build, and 100 or 125 s in, in three, when it met the tests. Each log names a module from
the packages U changes as missing or not loadable: `astro`, `astro/config`,
`astro/dist/i18n/middleware.js`, `@astrojs/internal-helpers/markdown` or
`@bruits/satteri-darwin-arm64`.

Hook B, then the merge it names, run at once by the session, while the gate runs (2 sessions, U,
10 rounds): `HEAD` reached `origin/main` 10/10. In the 9 rounds where the merge landed while the
gate still ran, `node_modules` held the old versions of 7 packages after the gate ended, since the
`post-merge` install skipped behind the gate's lock and said so on stderr. In the tenth the gate
had ended first and the install ran. The gate was green in the 7 rounds 0 to 6. Rounds 7 to 9 are
left out: they went red, first run and rerun, because Chrome for Testing 157 did not start. From
08:10 to about 08:25 another job's install of that build into the shared puppeteer cache stood
half written, its `unzip` waiting on input. The documents test that failed changes its working
directory to a temporary folder before it prints, and from there `cachedChrome()` takes the newest
build in the cache (157) rather than the one the checkout pins (156). Round 9's gate went red at
114 s, before its hooks started at 125 s.

Four sessions at once in the larger consumer, no gate, 10 rounds per row:

| Hook        | HEAD at `origin/main` | Stale after | Start median / max | Load      | The sessions read                                      |
| ----------- | --------------------- | ----------- | ------------------ | --------- | ------------------------------------------------------ |
| A           | 10/10                 | 0/10        | 128 ms / 329 ms    | 4.5–6.8   | "not merged" 30 of 40                                  |
| B (v5.16.0) | 0/10                  | 0/10        | 2.2 s / 6.2 s      | 4.5–6.8   | "fetch failed" 30, "ahead" 10, "install did not run" 3 |
| B (v5.17.1) | 0/10                  | 0/10        | 4.2 s / 6.2 s      | 5.2–6.3   | "fetch failed" 30, "ahead" 10                          |
| C (v5.17.2) | 10/10                 | 0/10        | 4.2 s / 6.4 s      | 15.8–21.3 | "not merged" 30 of 40                                  |

## What the numbers show

- **Red gates with `bun.lock` changed.** Hook A: 8 of 30 rounds, each at a module its install was
  rewriting. Hook B: 0 of 30, since it moves nothing and skips the install while the gate holds the
  lock. Hook C: 5 of 30, none at a module: Chrome exiting 2 while printing in four, a test timeout in
  one. With `bun.lock` unchanged each hook had one red round in 30, A and B timeouts, C a Chrome
  exit, each green when run again. C's concurrent rounds ran at loads up to 87, A's and B's up to 59.
- **Current at the start.** Behind with no other session, hook A brought `HEAD` to `origin/main`
  with nothing stale in 30 of 30 rounds. In the concurrent rounds `HEAD` reached `origin/main` in
  every round. Hook B moved `HEAD` in none and told the session how far it is behind in every round
  where its fetch succeeded. Hook C as hook A: 30 of 30 behind rounds with nothing stale, and every
  concurrent round.
- **Stale `node_modules`.** Hook A: 1 round of 30 with `bun.lock` changed, 14 packages, 8
  sessions. Hook B: none, as nothing moved. Once the session ran the merge hook B names during a
  gate, 9 of 9 such rounds left 7 packages stale. Hook C: 30 of 30 rounds with `bun.lock` changed
  left 7 packages stale after the gate, its install having skipped behind the gate's lock.
- **Concurrent fetches.** Under every hook the sessions' fetches into `refs/remotes/origin/main`
  collide: of n sessions, n−1 got an error in most rounds. Under hooks A and C one session per round
  still fast-forwarded, and the others read "not merged" without the reason.
- **Time to start.** Under 0.5 s median for every hook in documents. In the larger consumer the
  locked installs of hooks B and C queue on the lock: 2.2 to 4.2 s median and 6.4 s at most for four
  sessions, against 128 ms for hook A.
- **No network.** A name that does not resolve fails every hook within 0.5 s. An SSH connection
  that never answers holds hooks A and C until something stops it (Claude Code's hook timeout is
  600 s by default) and hook B for 21 s.
- **Uncommitted work.** No hook lost an edit in 90 rounds. Hooks A and C refuse the merge where the
  fast-forward touches the edited file.
- **The fix in v5.17.1.** Hook B at v5.16.0 skipped the install with the lock free in 3 of 40
  starts in the run the table shows, and in 4 of 40 in an earlier run of the same case; at v5.17.1
  in 0 of 40.

## Not measured

- A real Claude Code session: the hooks ran as Claude Code runs them, but no session read their
  output, so whether a session merges before its first answer when hook B tells it to is open.
- The chrome-devtools MCP server's own install at a session start, which both setups share.
- A remote over SSH waiting for a key approval: the hang case stands in for it with an ssh that
  never returns.
