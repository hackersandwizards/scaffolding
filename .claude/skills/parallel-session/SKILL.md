---
name: parallel-session
description: >-
  Track parallel work and the person's decisions as item files under docs/agent-work/items/ and
  dated reports, shown on the admin page, and choose between the shared checkout and a worktree. Use
  before a third delegate, before leaving a session running, for a worktree or release, and for
  "what is open" or a decision list.
---

# Parallel session

Goal, work and decision data live in the repo the work belongs to, never here. The tooling is the
admin engine, `@hackersandwizards/admin`, which each repo pins as a dev dependency: `admin-check`
checks the item files, and `admin-serve` serves the page across all repos at
`http://admin.localhost:4329` from each repo's last commit.

## One home per fact

- `docs/agent-work/items/<id>.md`: one file per item, YAML frontmatter plus a body starting with
  `# <title>`. `kind` is one of:
  - `goal`: the goal in the person's words, the limits, a deploy hold, the standing duties every
    batch carries out (such as a tracker kept in step or the repositories tidied), and one to
    eight done criteria, each checkable by someone who did none of the work and naming its proof.
    Usually `goal.md`, one per repo.
  - `work`: one open piece of work, with `owner` (whoever moves next: the person only for a
    decision or a step no agent tool reaches, else an agent or anyone else) and `evidence` (a commit hash, a file, or "not established"). A question whether
    something is on the list for later asks for a `work` item the person owns: read-only
    preparation for it (an inventory, candidates, a decision item) is welcome, and the work itself
    waits.
  - `decision`: a question with at least two `options`, or an agent assumption the person may
    veto. Every other such point an agent settles is `status: assumed`.
  - `review`: a request to look at something, with what to look at in the body. Only for what no
    reviewer can judge for the person; a choice a blind review settled and a run shipped gets no
    review item, and the run's report names it.

  A task, even one phrased as a question ("Who fixes the privacy policy?"), is `work`.

- `docs/agent-work/YYYY-MM-DD-<topic>.md`: one report per topic, what was measured, with evidence.
  Its images sit in `docs/agent-work/YYYY-MM-DD-<topic>/`, JPEG at most 1600 px wide. A diagram
  in it is a `mermaid` code block; the page drops styling lines.
- `docs/agent-work/items/<id>/`: the item's images, JPEG at most 1600 px wide, named in its `images`
  field by file name. The admin renders every review from the item in its own styles: an agent
  writes item data and images, never review HTML. The folder goes with its item.

Work that waits on a decision keeps its `work` item, whose body names the decision's `id` instead
of repeating the question. The open points for the person's return are the items in
`docs/agent-work/items/`. No second list exists.

## Item fields

Every item: `kind` and `status` (`open`, `assumed` or `decided`; `work` and `goal` are only ever
`open`). Every item but a goal: `priority` (1 to 3, 1 costs most if missed) and `owner` (who
answers, or for work who moves next: one name, with any later steps in the body). The body's
first sentence after the title states what the owner does, in under 120 characters; context
follows. Optional:
`order`, `area` (free text), `due` (ISO date), `evidence`, `needs` (item ids in the same
repository that are finished or decided first), `topic` (the name of a report in the same
repository, `YYYY-MM-DD-<topic>` without `.md`, whose page then shows the item). A decision or review may carry
`options` (each `key`, `label`, optional `detail`, and `score` and `noise` from a blind review),
`recommended` (an option key; a list where `multiple: true` lets the person pick several) and `images` (option key to
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

Items are written in English; a quotation keeps its original words. Give a new item the priority
and `order` of what it costs if missed against the open items.

## Steps

1. At start, read `docs/agent-work/items/` in every repo the work touches. Where no goal item
   exists and the work spans sessions or delegates, create `goal.md` with the goal quoted from
   the person's message; another repo's goal goes to a session in that repo. A work item another
   agent owns waits for its session. A `/goal` stop-hook rejection is
   a model's reading of the goal: it never decides an open decision item or overrides a ruling of
   the person. It is answered in two halves. The half no ruling of the person excludes you do
   before replying: tidying items and reports is not a new topic, and a process is in use only where
   its owning session is running something through it, shown per process. Only the half a ruling
   excludes is declined, once, with the `/goal` line. On the second such rejection, stop the loop, say why once, and give the person the
   `/goal clear` or `/goal <new condition>` line. Check: the goal item quotes the person.
2. Every message from the person that adds, decides or changes work gets its item in the same
   turn. A block pasted from the page ("Copy answers") holds one `repo:id: ` line per answer,
   then, comma-separated and each only where given: `agree` or `veto` on an assumed item, each
   pick as `key (Label)` or a bare `key`, or `done` for work marked done, and the note. The note
   may hold commas, so read the picks against the item's option keys. A line ending
   `; answered <time>, before the question or its options changed` is checked against the item's
   current question and options before anyone acts on it; where the pick no longer fits, the item
   stays open and the report says so. A line `repo:<report name>#<heading id>: <comment>` is the
   person's comment on that section of a report: edit the report. Write each answer for this repo into
   its item (step 4), commit, and confirm the id with its commit; an answer for another repo goes,
   quoted, to a session in that repo. Report an id that is unknown or already decided. Check:
   `git diff` shows the item.
3. A delegate's brief names the items it owns by `id`, quotes the item format, and says whether
   the delegate works in the shared checkout or a worktree. A delegate writes only its own item
   files and commits them with their paths named. After merging another session's work, read
   back the fields you wrote: a commit made from a copy older than yours reverts them without a
   conflict. Each delegate gets one batch with its write paths and a completion check that includes
   the goal's standing duties, and ends when that batch is committed. A fix round of the batch goes back to its implementer thread; other work goes to a fresh
   delegate briefed from paths, commits and open findings, never to a running one. A delegate
   messages only a result, a blocker or a question.
4. A finished work item is deleted in the commit that finishes it. An item the person decided
   takes `status: decided`, `decision` and `by`, then is deleted: in the commit that carries the
   decision out, or, where work remains, replaced by a `work` item naming the `id`.
   The same commit removes its `id` from every other item's `needs`, or the admin check fails.
   `git log --all -- docs/agent-work/items/<id>.md` finds a deleted item.
   A goal criterion counts as verified only after a delegate that built none of it checks it
   against the real result and writes PASS or FAIL with its reason under the criterion; until then
   report it as "reported met".
5. Before each commit that touches `docs/agent-work/items/`, run `bun run admin-check` in the repo.
   Check: it prints `ok`.
6. A report and an item state the current state only. A later batch on the same topic edits that
   report and deletes what it superseded. Earlier rounds and raw reviews go to the scratchpad. A
   clock time an item or report carries is the value a command printed in the tool call that
   writes it (`NOW=$(date '+%H:%M')`); an event no command timed gets no time, or `after <the
timed event>`.
7. The page reads each repo at its last commit, so the commit is all an item change needs.
   Check: where `curl -s http://admin.localhost:4329/` answers, the page lists the item. A batch
   that changes an asset an item's images show, such as a logo, colour or lockup, re-renders those
   images in that batch.
8. Every message the person types shows them reading now, one that says they are going away again
   included: in that turn, put the open `decision` items to them in one AskUserQuestion call, options
   read from the item, and report the rest
   from the items, all ordered by what each costs if missed.

## While the person is away

When the person says they are away, the session works unattended between their messages: every
question for the person becomes an item (step 2), put to them at their next message (step 8). The
session steers: it writes briefs, reads reports, keeps items current, and hands every ready batch
to a delegate. Every message to the person while the goal runs ends, in their terms and before
any text they must send or paste, on what finished since their last message, the Closing table and
the top priority.

## Closing

A batch is closed when, each read in that turn:

1. every commit's reviewer, by model, is the one `blind-review` names for its author;
2. every suite the gate leaves out that the batch's files can break (e2e, visual, smoke; read from
   `package.json` and the CI workflow) has run once, or the report names the CI run that ran it;
3. a defect the batch fixed is swept for its class in every repository the same change reached;
4. its item is deleted or current, and the delegate's servers, browsers and scratch are gone.

The session is closed when every batch is, and:

5. `polish` has run once in each repository the session changed;
6. every hub rule or skill the session changed is synced;
7. the transcript is read from its first message: every plan step, every item of the first
   report, every question put and its answer, every promise. Each unfinished one has an item.

A reply that calls a plan, a job or the session done, and every answer to what is open or remains,
gives the steps still open as one table (step, who, waits on), these seven included, then what
waits for the person.

## Shared checkout or worktree

The shared checkout is the default. Before giving a delegate a worktree, working inside one, removing one or releasing beside another session, read `worktree.md`.
