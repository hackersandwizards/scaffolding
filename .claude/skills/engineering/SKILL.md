---
name: engineering
description: >-
  How to build and change software here (docs over code, when to ask, what never to simplify, comments,
  silent-failure gates), before implementing a feature, refactoring, fixing a bug, reviewing a change or
  planning non-trivial repository work, never for content edits, prose or business records.
---

# Engineering

Architecture docs (CLAUDE.md, rules) outrank existing code where the two disagree. Given a bug
report, fix it on its best reading without asking, and name any other defensible reading with the
fix. Ask first only where no fix can start: the requirement contradicts itself or names a missing
artifact. Fix a bug test-first: a failing test that reproduces it, then the fix. Before editing the function a bug report names, read every caller, and fix the defect once where they all route through rather than on the one path the report names. Never simplify away input validation at a trust boundary, error
handling that prevents data loss, security measures, or accessibility basics.

- Cleanup, review and quality passes scan the whole working tree, not only the files this
  conversation touched. Another session's in-flight change sits beside today's work: read it for
  context and leave it to its author. An unstaged change you revert is gone from git for good.
- A parser answering "malformed" with the same value it gives "legitimately empty" turns a loud
  failure into a silent one. Put that gate at the parser, never at each consumer.
- Repairing a record that read as absent does not re-run the jobs that skipped it, and those jobs
  left no trace of the skip. Find the window between the corruption and the repair, then check the
  repaired records against their untouched siblings.
- Write no comment except for a fact neither the code nor a doc file states, such as an ordering constraint, an external quirk or the bug a guard exists for. Keep directive comments. A comment cites a commit, never a dated report, which a later report replaces.
- Verify each change with the checks that fit it, from the commands the repository's CLAUDE.md
  lists. You choose which; nothing requires the full gate every time, and your run is the only
  full one before the deploy.
- A git hook holds only what is irreversible or takes under about a second, run over the staged
  changes: the secret scan, format and lint, and checks of that size such as scaffolding's
  `check-staged` set or a repository's own `check:skills` when `.claude/` is staged. CI builds, runs the integration tests a deploy needs, deploys and applies Terraform after
  a plan. A schedule runs only to notice an absence no commit reveals, such as a new advisory
  against an unchanged lockfile.
- Start every tool the project installs through `bun run`: a package.json script where one fits,
  else the project's own binary (`bun run vitest run <file>`), never `bunx`, `npx` or
  `node_modules/.bin`. A person runs a repository's scripts through one entry point that lists
  them, never by path: in a bun project a package.json script, elsewhere a `justfile` recipe with a
  doc comment and a group, whose bare `just` lists them. Never both for one script.
  A repository pinning `@hackersandwizards/scaffolding` takes its hooks from scaffolding's skeleton
  (`check-structure --fix`). Elsewhere a hook is one line in `.githooks/` calling a script:
  `check:staged` runs `check-staged.ts` from this folder, `lfs:pre-push` runs `git lfs pre-push`
  where LFS is used. `scaffolding check` serialises `bun run check` itself. npm is stopped by
  `"engines": {"npm": "please-use-bun"}` in `package.json` with `engine-strict=true` in `.npmrc`; no
  install script guards the package manager, and a package other repositories install carries no
  `preinstall`, since a consumer's install-script check rejects it.
- Remove or replace a dependency with a known vulnerability before excusing it. An audit
  exception names the advisory ID.
- A browser that code or an MCP server starts is Chrome for Testing with a profile from `mkdtemp`
  under the OS temp folder, removed after the run, and `--use-mock-keychain --password-store=basic`,
  which puppeteer and Playwright pass themselves and a direct launch adds.
- A run that needs a running app starts its own on a free port and stops it by PID when done. It
  never stops or restarts a server it did not start.
- A trial of a forward-looking automation over past items gives each item only the data that
  existed when the automation would have acted: records from git history as of then, mail before
  then. Items still ahead run as the real test, and the brief states the cutoff.
- A build brief for a screen in a proof of concept forking a reference app names the reference
  screen, forbids hand-built substitutes for library components, and lists the reference app's UI
  audits as gates from the first wave.
- Every repository with a UI links its design-system catalogue in the UI, guarded by a coverage
  test and named in its `CLAUDE.md`. A catalogue shows what its repository adds to or changes
  from the packages it builds on (brand's elements, slides' slide types) and one tile per brand
  element its `brand-elements.json` lists as used, which brand's `brand-elements` requires; never
  other parts of those packages, nor its own content such as decks. An element two repositories
  build moves into the package they share.
- Decks run only on our own slide engine, never Slidev or reveal.js. Two exceptions stay and are
  never proposed for porting: the one client reveal.js deck in Company OS and a partner's own
  course repositories.
- Module-scope function names are unique per repository, except a framework-dictated name or a
  test-local helper.
- Removing a collection, a skill or an agent also deletes the tests that named it. Port every
  deleted case whose subject still exists: no gate goes red when coverage disappears.
