# This production file exceeds 300 lines because it groups unrelated responsibilities in one module.

When one file owns multiple concerns, unrelated changes modify the same module and pull unnecessary dependencies into its callers.

Find the fix: list every export alongside the files that import it. Exports imported by different groups of callers belong in separate modules. When all exports share callers, split by distinct responsibility so each new file owns one concept you can name and test independently. Place each new file in the folder given by `docs/architecture/layers.md` where the repository has one, and update callers to import from the new path. A file of only values (tables, sample data, slide content) with no functions is data; declare its path in the lint config with the reason. Any file declaring a function is production code, not data. Stop when each code file owns one concern in 300 lines or fewer.

No fix: naming the file `utils.ts` or `part2.ts`, or leaving a re-export file only so callers skip updating imports (unlike a package entry file). Moving a data table or private helpers out only to import them back, deleting comments or blank lines, or joining lines is also no fix.
