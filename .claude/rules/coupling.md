---
paths:
  - "**/package.json"
  - "**/{bun.lock,bun.lockb,package-lock.json,pnpm-lock.yaml,yarn.lock}"
  - "**/{pyproject.toml,uv.lock,requirements*.txt,Cargo.toml,go.mod}"
  - "**/node_modules/@hackersandwizards/**"
  - ".gitmodules"
  - ".github/**"
---

# Coupling

Keep repositories as loosely coupled as the job allows: each builds, tests and runs from its own
checkout and the packages it pins.

- A defect a review of one deck, page or document finds in its engine or in the brand is fixed in
  the engine, or in the brand where every surface reviews better with the change, never worked
  around in that one artifact, which stays in brand form until the fix lands.
- Take what another repository owns from what it publishes: a package installed from a version tag,
  used only through its `bin` commands, run as `bun run <name>`, and the files its `exports` names,
  or a URL its owner publishes. A sibling path (`../<repo>`), a package path outside `exports` and
  another repository's checkout belong to their owner and may move.
- A package other repositories use declares that surface in `bin` and `exports`. Renaming a
  command, changing its arguments or moving an exported file is a release whose commit names the
  change. A release that needs a newer version of another of our packages, or needs it installed
  for a command it ships, names that minimum in its commit, the line a consumer reads at the raise.
- Pins follow releases twice over: whoever releases a package raises the consumers it reaches in
  the same pass, and every consumer catches up twice a day on what a release wave left behind, both
  through the `pins` mode of `dependency-updates`.
- The hub's rule and skill sync is the one sync between repositories.
- Take a fact another repository owns, such as a brand value, a price or a product fact, from its
  package, never retyped or copied. The one copy allowed is a file the repository serves while it
  cannot install the package, recorded beside the copy with its origin and version.
- Read a dependency's licence before adding it, and decide whether this project may take it under
  that licence: what the licence demands (copyleft such as GPL or AGPL, attribution, non-commercial
  or source-available terms) against how the project is used and passed on (internal tool, client
  delivery, public repository, sold product). Add one whose terms the project cannot meet only
  with the person's decision. Where the project has its own licence check or policy, it decides.
- A check of consumers ships as a command each consumer runs in its own gate, never as a script in
  the owner that reads their checkouts.
- Where two repositories only look alike, each keeps its own code rather than sharing a package.
