---
name: dependency-updates
description: >-
  Update a repository's dependencies: raise every external dependency of every kind to its newest
  release, majors included, with the repository's own tooling, clear advisories, fix what breaks, one
  commit per repository; with `pins`, raise only our own package pins. Use for "dependency
  updates", "update dependencies", "fix advisories", "Abhängigkeiten aktualisieren", "raise the
  pins", "raise the consumers".
---

# Dependency updates

Work through each repository you are given, one at a time.

1. Raise every external dependency to its newest release, majors included, with the means the
   repository normally uses for that kind: packages and their lockfiles, toolchain pins, container
   and CI images, Terraform providers and modules, and anything else pinned to an outside version.
   Package managers do not report a newer tag of a git dependency (`git+ssh://…#vX`, our own
   `@hackersandwizards/*` included): read the newest tag with `git ls-remote --tags <url>` and raise
   the pin to it. A pin written as a commit with the tag as a trailing comment keeps that form: take
   the tag's commit from `ls-remote` (its `^{}` line where annotated) and update the comment. Clear every open security advisory, replacing a dependency no release fixes.
2. Fix what the updates break until the checks the repository's `CLAUDE.md` names are green. Roll
   back only an update you cannot make green.
3. Commit everything as one commit and push it. Nothing changed means no commit.

Keep one version per tool on the machine, the newest; an older one only for a named regression.

Report per repository: the commit hash or "nothing to update", and each dependency or advisory left
behind, with the failing check or advisory ID.

## Pins only

With the argument `pins`, raise only the `@hackersandwizards/*` pins, in each repository given:

1. `git fetch` and `git merge origin/<default branch>`. Skip a repository whose branch then holds
   commits `origin` lacks, and name it: its push would carry another session's work.
2. `bun install --frozen-lockfile`, so `node_modules` holds the scaffolding the merged lockfile
   pins: a checkout or merge hook can leave an older one installed, and `raise-pins` then answers
   "Script not found". Skip a repository with no `node_modules/.bin/raise-pins` after it, and name
   it: it pins a scaffolding older than v5.18.0.
3. `bun run raise-pins --commit`. Read its `[raise-pins]` lines, never its exit status: a pin it
   keeps because it read no tag from the remote exits 1 after a green commit too. A pin whose name
   lacks the scope is left out without a line.
4. After a `committed "<message>"` line, push. A rejected push repeats step 1 without its skip,
   since the raise is itself a commit `origin` lacks, then the push, once. After `gate red`, fix
   what broke as step 2 of the first list says, then commit and push. A run whose approval excludes
   fixes changes nothing instead: the raise stays uncommitted in `package.json` and `bun.lock`, and
   every later `raise-pins` there stops at its uncommitted-manifest check until a session fixes or
   reverts it.

Report per repository: its `[raise-pins]` lines, the commit and push, or the skip and its reason.
An uncommitted-manifest stop and every end that leaves a raise uncommitted or unpushed are
`blocked`, every run they recur.
