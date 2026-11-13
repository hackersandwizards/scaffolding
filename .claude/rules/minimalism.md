# Minimalism

Write the laziest solution that works, in code, in instruction artifacts (skills, agents, rules,
prompts) and in any document. Say the least that fully does the job, then stop.

**The ladder.** Stop at the first rung that holds:

1. Does this need to exist at all? If speculative, skip it and say so. Where the omission fails
   silently, as a missing allowlist entry or fail-closed guard does, include it and name why.
2. Does this repository already have it? Search for an existing helper, type, script, skill or
   section and reuse it before writing a new one.
3. Standard library does it? Use it.
4. Native platform feature covers it? Use it.
5. A dependency solves it, installed or added to the project? Use it. Never add one for what a few
   lines do.
6. Can it be one line? One line.
7. Only then: the minimum code that works.

**Rules:**

- Every changed line traces to the request, except cleanup: remove dead code, orphans and no-ops
  wherever you find them, never another session's uncommitted work. A setting a person committed or
  switched off is a decision: neither a cleanup nor a fix by another route changes it without
  asking. Grep documentation and instruction artifacts before calling uncalled code dead.
- Leave the machine as you found it, apart from updates. Start no process whose only job is to
  consume CPU, memory or disk, a load generator for a measurement included: measure under the load
  the machine already has. Before reporting done, remove what your
  own run created and no longer needs: scratch files, backups, container images, build or runner
  caches and software installed outside a project, which stays only with the person's go. Remove
  only exact paths your own run created, never by prefix, and never a scratch file that is the only
  copy of a deliverable. Never quit or restart a desktop app the person runs, Claude Desktop included: an
  edit that needs it closed waits for their quit. Open their desktop apps, such as Word, only after
  they agree, and run browsers headless while they work. Every Chrome you launch yourself, a scratch
  script's included, is Chrome for Testing, the build puppeteer or Playwright installs, never
  `/Applications/Google Chrome.app`, whose headless instance takes the person's Dock click, and runs
  with `--use-mock-keychain --password-store=basic`, or macOS asks them for the keychain password. The
  Mac's Trash is emptied within hours: before moving a folder there, list its untracked and ignored
  files, and leave it where any holds state or secrets until the person confirms.
- No interface, factory or config for a single case, and no scaffolding for later.
- Change what exists by removal first, then replacement, then addition. Where a removal drops a
  rule you still want, replace it.
- Fewest files possible, each stating what is true now: git holds the history. The shortest working
  diff wins.
- One owner per fact or rule: state it once, in the file that owns it, and point there. This stops
  at a skill's edge: a skill's files point only at that skill's own files and at the repository data
  and scripts it acts on, never at another skill, rule, agent or memory file. It may name the
  reference skill that owns a channel it calls, to load before the first call, since that skill
  carries the channel's tool grants and limits, and a skill it runs as one of its steps. A skill whose subject is the inventory of those
  artifacts may name them in the rows it catalogs, and no other skill cites such a row ID.
  Redundancy between skills is the price of that independence.
- A list whose gaps read as answers keeps a row that restates its owner where the missing row would
  say "nothing is needed here". Where it would send the reader elsewhere, the row goes.
- Cut a line a capable model follows without it, one whose case never arises or would announce
  itself, and one restating what a system of record provides. That test reads on a rule, never on a
  record. A line preserving something observed, a measured number, a verbatim phrasing, how a
  particular person sounds, stays: without it the model invents a plausible substitute.

**Output:** name what you left out and when adding it becomes worth it. For a complex request, build
the simplest version that works first and improve it from review or research. Simple never means
skipping the research or review the task needs: finding the simple solution often takes research.
Never stall on an answer you can default.
