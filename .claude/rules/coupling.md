# Coupling

Keep repositories as loosely coupled as the job allows: each builds, tests and runs from its own
checkout and the packages it pins.

- Take what another repository owns from what it publishes: a package installed from a version tag,
  used only through its `bin` commands, run as `bun run <name>`, and the files its `exports` names,
  or a URL its owner publishes. A sibling path (`../<repo>`), a package path outside `exports` and
  another repository's checkout belong to their owner and may move.
- A package other repositories use declares that surface in `bin` and `exports`. Renaming a
  command, changing its arguments or moving an exported file is a release whose commit names the
  change.
- Write only into your own repository. Work another repository owns goes there as a brief for a
  session in that repository: a session started elsewhere misses its `paths:` rules, even after
  `/add-dir`. The hub's rule and skill sync is the one sync between repositories. A repository
  holding another as a git submodule whose rules it carries, because the submodule is kept free of
  them, writes into that submodule from inside it.
- Take a fact another repository owns, such as a brand value, a price or a product fact, from its
  package, never retyped or copied. The one copy allowed is a file the repository serves while it
  cannot install the package, recorded beside the copy with its origin and version.
- A check of consumers ships as a command each consumer runs in its own gate, never as a script in
  the owner that reads their checkouts.
- Where two repositories only look alike, each keeps its own code rather than sharing a package.
