# This production file exceeds 300 lines because it groups unrelated responsibilities in one module.

When one file owns multiple concerns, unrelated changes modify the same module and pull unnecessary dependencies into its callers.

Find the fix: list every export alongside the files that import it. Exports imported by different groups of callers belong in separate modules. When all exports share callers, split by distinct responsibility so each new file owns one concept you can name and test independently. Place each new file in the folder given by `docs/architecture/layers.md` where the repository has one, and update callers to import from the new path. Stop when each production file owns one concern in 300 lines or fewer.

No fix: naming the new file `utils.ts` or `part2.ts`, or keeping a re-export file at the old path. Moving a data table or private helpers out only to import them back, deleting comments or blank lines, or joining lines is also no fix.
