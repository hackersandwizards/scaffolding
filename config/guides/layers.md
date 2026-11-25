# The saved layer map in `docs/architecture/layers.md` does not match the current imports and restrictions.

The layer map falls out of date when code adds or removes an import across layers, or when layer restrictions change. Committing regenerated changes without review lets unintended dependencies enter the architecture.

Find the fix: run `bun run scaffolding layers --write` and read the full diff of `docs/architecture/layers.md`. Check every added dependency arrow against the repository's architecture rules in `CLAUDE.md` or its layer document. When those documents do not authorise a new arrow, escalate it to the repository's architecture owner instead of approving it yourself. If an arrow is unintended, remove the import that introduced it and run the command again until the diff shows only approved edges. Commit the updated file alongside the code change.

No fix: regenerating and committing without reading the diff, treating a new arrow as approved because the import exists, or deleting `docs/architecture/layers.md`.
