---
kind: work
status: open
priority: 3
owner: agent
evidence: "not established"
---

# Mail's first gate after the pin raise failed once, cause not yet known

On 07.11., the first `bun run check` in mail after the pin raise to scaffolding v2.18.0 failed after
11.8 s. Which step failed was not recorded. Three later runs passed.

The talks failure from the same day (`ENOTEMPTY` on `node_modules/.astro/vite-sync/deps`) has a
known cause: `astro check` and `astro build` both committed into Astro's sync cache at once. Since
v2.18.1 the catalog build waits for the typecheck. That cause does not fit mail: its typecheck is
`tsc`, so `astro build` is the only Astro process in mail's shared steps.

Measured on 07.11.:

- 10 runs from a cold `catalog/node_modules/.astro/vite-sync` and `catalog/node_modules/.vite`:
  10 passed (12 to 25 s each).
- A passing gate takes 11.7 s, so a failure at 11.8 s fits a late step of the repository's own
  (`check:frames`, `check:retired`) as well as a shared one.

Next: when mail's gate fails again, keep the whole output and record the failing step's `FAIL`
line here. Until then, nothing in it points at scaffolding.
