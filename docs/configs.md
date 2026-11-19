# Configs

| Export                                         | Use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./eslint`, `./eslint/astro`                   | `export default [...base, ...]` in `eslint.config.js`; browser, Node and Bun globals; in a test, an empty test body and `expect().rejects` or `.resolves`, which bun waits for in a nested event loop that broke a shared puppeteer connection, go red; in TypeScript files the typed rules ([The gate](gate.md)), which need each file in a `tsconfig.json`; `dist/` at any depth and every submodule `.gitmodules` names are skipped                                                               |
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

## Vitest and Stryker

Scaffolding 5.30.0 supplies Vitest 5.1.0 and Stryker core and its Vitest runner at 10.1.1.
After the release tag is available, update the scaffolding pin in `devDependencies` to
`git+https://github.com/hackersandwizards/scaffolding.git#v5.30.0`. Remove the direct
`vitest`, `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` pins where present.
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

### `./stryker`

Replace `stryker.config.json` with `stryker.config.mjs`. Stryker loads a JavaScript default export
and has no config inheritance field in JSON. Drop the JSON `$schema` line and use this shape with
the repository's existing mutation globs.

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
two workers, ignores dotfiles and static mutants, and cleans `.stryker-tmp` after each run.
It writes the clear-text report to the terminal and the JSON and incremental reports to
`.stryker-reports/mutation.json` and `.stryker-reports/incremental.json`. Run mutation testing
with `bun run mutation` on demand.
