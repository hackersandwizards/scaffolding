---
name: dependency-updates
description: >-
  Update a repository's dependencies: raise every external dependency of every kind to its newest
  release, majors included, with the repository's own tooling, clear advisories, fix what breaks, one
  commit per repository. Use for "dependency updates", "update dependencies", "fix advisories",
  "Abhängigkeiten aktualisieren".
---

# Dependency updates

Work through each repository you are given, one at a time.

1. Raise every external dependency to its newest release, majors included, with the means the
   repository normally uses for that kind: packages and their lockfiles, toolchain pins, container
   and CI images, Terraform providers and modules, and anything else pinned to an outside version.
   Package managers do not report a newer tag of a git dependency (`git+ssh://…#vX`, our own
   `@hackersandwizards/*` included): read the newest tag with `git ls-remote --tags <url>` and raise
   the pin to it. Clear every open security advisory, replacing a dependency no release fixes.
2. Fix what the updates break until the checks the repository's `CLAUDE.md` names are green. Roll
   back only an update you cannot make green.
3. Commit everything as one commit and push it. Nothing changed means no commit.

Keep one version per tool on the machine, the newest; an older one only for a named regression.

Report per repository: the commit hash or "nothing to update", and each dependency or advisory left
behind, with the failing check or advisory ID.
