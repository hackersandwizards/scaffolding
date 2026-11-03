---
name: parallel-session
description: Track parallel work and the person's decisions in repo files (one item file per decision, review, work item or goal under docs/agent-work/items/, dated reports) and the admin hub page of what needs the person, so the person can review after being away, and choose between the shared checkout and a worktree per delegate. Use before fanning out a third delegate, before leaving a session running, and for "what is open", "what needs me", "decision list", "Entscheidungsliste", "worktree".
---

# Parallel session

Goal, work and decision data live in the repo the work belongs to, never here. The tooling is the
admin engine, `@hackersandwizards/admin`, which each repo pins as a dev dependency: `admin-check`
checks the item files, and `admin-serve`, started by hand with `bun run start` in the admin checkout,
serves the page across all repos at `http://admin.localhost:4329` from each repo's last commit.

## One home per fact

- `docs/agent-work/items/<id>.md`: one file per item, YAML frontmatter plus a body starting with
  `# <title>`. `kind` is one of:
  - `goal`: the goal in the person's words, the limits, what done means, and a deploy hold.
    Usually `goal.md`, one per repo.
  - `work`: one open piece of work, with `owner` (whoever moves next: the person, an agent or
    anyone else) and `evidence` (a commit hash, a file, or "not established").
  - `decision`: a question with at least two `options`, or an agent assumption the person may
    veto. Only for direction, money, a relationship or anything leaving the company. Every other
    such point an agent settles is `status: assumed`; a minor or reversible default is named in
    the report only.
  - `review`: a request to look at something, with what to look at in the body.

  A task, even one phrased as a question ("Who fixes the privacy policy?"), is `work`.
- `docs/agent-work/YYYY-MM-DD-<topic>.md`: one report per topic, what was measured, with evidence.
  Its images sit in `docs/agent-work/YYYY-MM-DD-<topic>/`, JPEG at most 1600 px wide.
- `docs/agent-work/items/<id>/`: the item's images, JPEG at most 1600 px wide, named in its `images`
  field by file name. The admin renders every review from the item in its own styles: an agent
  writes item data and images, never review HTML. The folder goes with its item.

Work that waits on a decision keeps its `work` item, whose body names the decision's `id` instead
of repeating the question. The open points for the person's return are the items in
`docs/agent-work/items/`. No second list exists.

## Item fields

Every item: `kind` and `status` (`open`, `assumed` or `decided`; `work` and `goal` are only ever
`open`). Every item but a goal: `priority` (1 to 3, 1 costs most if missed) and `owner` (who
answers, or for work who moves next; a decision for Stefan sets `owner: Stefan`). Optional:
`order`, `area`, `due` (ISO date), `evidence`. A decision or review may carry `options` (each
`key`, `label`, optional `detail`, and `score` and `noise` from a blind review), `recommended` (an
option key; a list where `multiple: true` lets the person pick several) and `images` (option key to
an image or a list of them, each a file name or `{src, caption}`, or a list for the item as a
whole). A table, such as scores per criterion, goes in the body as Markdown. `assumed` states `assumption` or
`recommended`. `decided` means the person's own answer and states `decision` and `by`, with
`quote` for the person's words; a choice an agent made is `assumed`. Any other field fails
`admin-check`.

```md
---
kind: decision
status: open
priority: 2
owner: Benedikt
recommended: a
options:
  - key: a
    label: Variant A
    detail: What choosing it changes.
  - key: b
    label: Variant B
---

# Which variant ships?

The question's context, in Markdown.
```

Items are written in English; a quotation keeps its original words. Across the repos the hub
lists, the open items fill every priority from 1 to 3. Give a new item the priority and `order`
of what it costs if missed against the open items, and when a level empties, move the costliest
items up.

## Steps

1. At start, read `docs/agent-work/items/` in every repo the work touches. Where no goal item
   exists and the work spans sessions or delegates, create `goal.md` with the goal quoted from
   the person's message. A work item outside the session's goal waits for its own session,
   whoever owns it. Check: the goal item quotes the person.
2. Every message from the person that adds, decides or changes work gets its item in the same
   turn. A pasted block from the page ("Copy answers") holds one `repo:id: choice, note` line per
   answer: write each into its repo (step 4), commit, and confirm every id with
   its commit; report an id that is unknown or already decided. Check: `git diff` shows the item.
3. A delegate's brief names the items it owns by `id`, quotes the item format, and says whether
   the delegate works in the shared checkout or a worktree. A delegate writes only its own item
   files and commits them with their paths named. After merging another session's work, read
   back the fields you wrote: a commit made from a copy older than yours reverts them without a
   conflict. Each delegate gets one batch with its write paths and a completion check, and ends
   when that batch is committed. Further work goes to a fresh delegate briefed from paths,
   commits and open findings, never to a running one. A delegate messages only a result, a
   blocker or a question.
4. A finished work item is deleted in the commit that finishes it. An item the person decided
   takes `status: decided`, `decision` and `by`, then is deleted: in the commit that carries the
   decision out, or, where work remains, replaced by a `work` item naming the `id`.
   `git log --all -- docs/agent-work/items/<id>.md` finds a deleted item.
5. Before each commit that touches `docs/agent-work/items/`, run `bun run admin-check` in the repo.
   Check: it prints `ok`.
6. A report and an item state the current state only. A later batch on the same topic edits that
   report and deletes what it superseded. Earlier rounds and raw reviews go to the scratchpad.
7. The page reads every repo under `~/dev` with `docs/agent-work/items/` or an
   `@hackersandwizards` dependency at its last commit, so the commit is all an item change needs.
   Check: where `curl -s http://admin.localhost:4329/` answers, the page lists the item. A batch
   that changes an asset an item's images show, such as a logo, colour or lockup, re-renders those
   images in that batch.
8. When the person returns, report from the items, ordered by what each costs if missed. Before
   ending the session, read the transcript from its first message: every item of the first
   report, every question put and its answer, every promise. Check: each unfinished one has an
   item.

## While the person is away

When the person says they are away, the session works unattended until they return: every
question for the person becomes an item (step 2), never a chat message. The session steers: it
writes briefs, reads reports, keeps items current, and hands every ready batch to a
delegate. When a delegate finishes, stop the servers and browsers it started and delete its
scratch then, not at session end. Check: no process or scratch folder of a finished delegate
remains.

## Shared checkout or worktree

The shared checkout is the default. Give a delegate a worktree only where the shared index costs
more than the worktree: several delegates committing in one repo at once, or a long run changing
app code that the full gate checks. Short record and document edits stay in the shared checkout.

A worktree in os costs about 1.5 GB of disk and 5 s to create, `bun install` about 2 s from a warm
cache, plus cold Astro and Vite caches. The gate's lock serialises runs within one checkout only,
so each worktree's full gate runs beside the others.

- Before the fan-out, commit and push everything the delegates need: a worktree starts from
  `origin/main`.
- `isolation: worktree` creates `.claude/worktrees/<name>/` on a local branch `worktree-<name>`.
  Where `git check-ignore -q .claude/worktrees/x` fails, add `.claude/worktrees/` to the repo's
  `.gitignore` first. A linter run over the whole tree, such as `eslint .`, also lints a worktree
  there unless its config ignores the path.
- A hand-made worktree goes outside the repo with no branch:
  `git worktree add --detach <scratchpad>/<run>-wt origin/main`.
- The delegate installs the repo's dependencies in its worktree (`bun install` in os) before its
  first commit, since the hook needs them. It commits there, then runs `git fetch`, `git rebase origin/main` and
  `git push origin HEAD:main`, repeating on rejection, before its run ends. Check:
  `git log origin/main..HEAD` prints nothing.
- Remove each worktree as soon as its delegate's work is on `main`, while the session goes on, so
  none outlives it: `git worktree remove <path>` once, inside it, `git log origin/main..HEAD` and
  `git status --porcelain` both print nothing. Delete a `worktree-<name>` branch with
  `git branch -D` once `git log origin/main..worktree-<name>` prints nothing. `git worktree remove`
  drops a clean worktree's unpushed commits without a warning.
