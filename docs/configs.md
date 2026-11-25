# Configs

| Export                                         | Use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./eslint`, `./eslint/astro`                   | Use the plain preset for JavaScript or TypeScript, or the Astro preset for repositories with Astro. They provide the remaining ESLint rules, including the checks for empty tests and `expect().rejects` and `.resolves`.                                                                                                                                                                                                                                                                            |
| `./oxlint`                                     | The base for `.oxlintrc.json`. The gate runs Oxlint and its TypeScript companion from scaffolding’s dependencies.                                                                                                                                                                                                                                                                                                                                                                                    |
| `./tsconfig/bun.json`, `./tsconfig/astro.json` | `"extends"` in `tsconfig.json`; `include` and `paths` stay in the repository                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `./prettier`                                   | `"prettier": "@hackersandwizards/scaffolding/prettier"` in `package.json`, `.astro` included; a config adding plugins lists `...base.plugins` first                                                                                                                                                                                                                                                                                                                                                  |
| `./stylelint`                                  | `export default styles({ importFrom: [...] })` in `stylelint.config.js`; every submodule `.gitmodules` names is skipped                                                                                                                                                                                                                                                                                                                                                                              |
| `./chrome`, `./serve`                          | Chrome for Testing: `chromeBinary` takes `CHROME_BINARY`, else the build the repository's `puppeteer-core` pins (newest cached without one), installed into puppeteer's cache where missing, with the shared flags; a gate server on a port the system hands out, answering within 20 s times `machineLoad().factor` unless `timeoutMs` says otherwise, its stderr passed through with `stderr: true`, and a server that exits before answering failing with its exit code and the end of its stderr |
| `./rejection`                                  | `expect(await rejection(promise)).toContain("...")` in a test: the error the promise rejects with, as text; a promise that resolves fails the test, naming its value's first 200 characters, and the trace names the calling line                                                                                                                                                                                                                                                                    |
| `./catalog`, `./catalog/*`                     | the catalog preset and the shell's files: [The catalog](catalog.md)                                                                                                                                                                                                                                                                                                                                                                                                                                  |

TypeScript comes as two packages until typescript-eslint can read TypeScript 7, which ships no
compiler API yet: `"typescript": "npm:@typescript/typescript6@…"` for the TypeScript 6 API it
imports, and `"@typescript/native": "npm:typescript@7…"` for `tsc`. A plain `typescript` 7 breaks
lint; the alias alone leaves no `tsc`.

The stylelint base lets a stylesheet, and the `<style>` blocks of an Astro component, read only the
custom properties brand's `tokens.root.css` (from the repository's installed brand), the files in
`importFrom` and the same file define. An `importFrom` entry starting with `./`, or a bare file
name, is a file of the repository; any other path with a slash is a package's. The base cannot load
without brand installed, so a repository without brand gives `skip.styles` a reason. A property a
component sets from its markup (a `style` attribute) is read with a fallback,
`var(--accent, transparent)`.

## Oxlint and ESLint

Run `bun run check-structure --fix` after raising scaffolding. It creates the root
`.oxlintrc.json` from the skeleton if the file is missing. Keep the skeleton's `extends`, `plugins`,
`env`, `options.typeAware` and `ignorePatterns` entries. Oxlint's JSON `extends` takes a relative
file path and does not inherit the plugins, environment or ignore patterns. Keep the repository's
existing source and generated-file scopes in both configs where applicable. A submodule is skipped
by the gate using `.gitmodules`.

In `eslint.config.js`, keep the shared preset and any ESLint-only rules. Move the repository's
`no-restricted-imports` blocks to `.oxlintrc.json`. A scoped policy can use an override such as

```json
{
  "files": ["src/**/*.{ts,tsx,astro}"],
  "excludeFiles": ["**/*.test.ts"],
  "rules": {
    "no-restricted-imports": [
      "error",
      {
        "patterns": [{ "regex": "^@/server/", "allowTypeImports": true }]
      }
    ]
  }
}
```

Add this object to the root config's `overrides` array. An Astro file glob covers its frontmatter
and client scripts. Where policies overlap, put every restriction that applies in the final matching
block, because Oxlint replaces that rule's options. For a remaining ESLint rule that should apply
to Astro client scripts, use `**/*.astro/*.ts`.

Remove `baseUrl` from a TypeScript project that uses it and write each path target relative to
`tsconfig.json`, for example `"@/*": ["./src/*"]`. Oxlint's TypeScript companion rejects `baseUrl`.

### Rule guides

Rule guides live in `config/guides/`. In the gate, Oxlint prints each matching guide once after failures and ESLint after its findings. The layer and cycle checks do the same for stale or missing layer maps and runtime import cycles. The package test fails if the shared Oxlint or ESLint config enforces a rule without a guide.

## Vitest and Stryker

Scaffolding supplies Vitest 5.1.0 and Stryker core and its Vitest runner at 10.1.1.
Use a Scaffolding pin of v5.33.0 or later for the setup below. The shared configs and their
TypeScript declarations first shipped together in v5.30.1. Remove direct pins for
`vitest`, `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` where present, along with any
local declarations for the shared config imports.
Keep any coverage provider the repository uses at the version matching Vitest. Run `bun install`
to refresh the lockfile. The existing test and mutation scripts still run the same commands with
Bun's hoisted installs. On Node 22, those commands need at least Node 22.12.

### `./vitest`

Use this as the entire root `vitest.config.mjs` when the repository needs only the shared settings.

```js
export { default } from "@hackersandwizards/scaffolding/vitest";
```

To keep local settings, replace `export default defineConfig({ … })` with
`export default mergeConfig(base, { … })` and use these imports.

```js
import base from "@hackersandwizards/scaffolding/vitest";
import { mergeConfig } from "vitest/config";

export default mergeConfig(base, {
  test: { include: ["test/**/*.test.ts"] },
});
```

Remove the duplicated timeout calculation and the `testTimeout` and `hookTimeout` properties.
The base reads both from `SCAFFOLDING_TEST_TIMEOUT_MS` with a 5000 ms fallback. Keep any intentional
timeout overrides, including project-level limits. It also excludes `**/.stryker-tmp/**` alongside
Vitest's default exclusions and preserves symlinks in Vite resolution and worker arguments during
mutation runs. Add local exclusions through `mergeConfig`, which appends them to the base array.
Remove any duplicate `defaultExclude` spread from the local exclusion list.

### `./property`

Keep properties in `*.prop.test.ts` files and examples in ordinary test files. Import
`test` and `fc` from this package. You can alias either import. The shared ESLint config
checks the file name, import and callback assertion.

```ts
import { fc, test } from "@hackersandwizards/scaffolding/property";
import { expect } from "vitest";

test.prop([fc.array(fc.integer())])("a copy preserves every element", (values) => {
  expect(values.slice()).toEqual(values);
});
```

Give each statement one test. Use an example for a concrete regression or a property to cover a
rule across generated inputs. When a shrunk input exposes a defect in a rule the property already
owns, add the input to that property's `examples`. Mutation testing changes the code to judge
the tests.

Importing `./property` configures seed `17401` with 64 cases in the normal suite and 12 under
Stryker. Vitest runs per-case hooks and reports the seed and shrunk counterexample on failure.
Put property options in an inline object. The shared ESLint config rejects per-property
`seed` and `numRuns`. For string inputs that need Unicode and length, import
`unicodeString`. It generates grapheme clusters with a maximum of 1,024 clusters. Use
`examples` for exact boundaries that each run must exercise.

Run `bun run scaffolding-explore` for 512 cases per property with a fresh seed and a two-minute
wall limit. The shared Vitest preset uses eight times the normal per-test timeout, capped at
the wall limit. Run `bun run scaffolding-explore --seed <seed>` to replay the run.
Exploration runs Vitest directly from the repository root with coverage disabled and
loads the repository's standard Vitest config. It uses Node by default and Bun when
`scaffolding.test` (or the `test` script by default) starts with `bun --bun vitest` or
`bun --bun run vitest`. It exits 2 in CI, a Git hook or the gate. Custom Git hooks can set
`SCAFFOLDING_GIT_HOOK=1` before calling package scripts.

### `./stryker`

Replace `stryker.config.json` with `stryker.config.mjs`. Stryker loads a JavaScript default export
and has no config inheritance field in JSON. Drop the JSON `$schema` line and use this shape with
the repository's existing whole-file mutation globs. `check-structure` reports line and column
ranges in literal `mutate` arrays.

```js
import base from "@hackersandwizards/scaffolding/stryker";

export default {
  ...base,
  mutate: ["src/example.ts"],
  vitest: { ...base.vitest, configFile: "vitest.mutation.config.mjs" },
  ignorePatterns: [...base.ignorePatterns, "/dist"],
};
```

Keep the `vitest` and `ignorePatterns` overrides only where the repository needs a custom config,
pool, test selection or additional ignores. When `related` was omitted from the JSON, add
`related: true` to retain Stryker's original test selection. Keep custom plugins and measured
concurrency after `...base`. The base sets `vitest.related` to `false`, uses per-test coverage and
two workers, ignores dotfiles, sets `ignoreStatic: true`, and cleans `.stryker-tmp` after each run.
It writes the clear-text report to the terminal and the JSON and incremental reports to
`.stryker-reports/mutation.json` and `.stryker-reports/incremental.json`.

Set `"mutation": "scaffolding-mutation"` in `package.json` and run `bun run mutation` on demand.
With `ignoreStatic: true`, Stryker skips mutants that have only module-load coverage. It runs
mutants that also have per-test coverage against their covering tests. After Stryker's output,
the wrapper reads the fresh `.stryker-reports/mutation.json` and lists each `static: true`
survivor by file, line and mutator. It prints the count and a score that excludes those survivors
alongside Stryker's score. The adjusted score is `n/a` when no scored mutants remain.

The command stops Stryker and its workers at the 15-minute wall limit and exits with status 124.
To narrow a run, use `bun run mutation --mutate <files>`. Mutation testing stays outside the gate,
hooks and CI.

`SCAFFOLDING_MUTATION_BUN=1` runs Stryker on Bun. For suites that use Bun APIs, set
`"mutation": "SCAFFOLDING_MUTATION_BUN=1 scaffolding-mutation"`. The shared Stryker config uses
the forks pool on Bun. The shared Vitest config inlines the property wrapper and its adapter
inside Stryker workers.
