---
name: delegation
description: >-
  Hand work over in any direction between harnesses, launch, prod, stop and check a delegate,
  which model and effort each role runs at: before starting any delegate, before code work (an implementation,
  a bug fix, a refactor, tests, a script, a dependency update, a polish pass), when running or
  configuring Codex, or when either side needs copy written.
---

# Delegation

## Handing over

Every handoff, in any direction and to any model, goes through the harness's own delegation tool
where it reaches the target: `delegate_task` in T3 Code (`t3_thread_launch` with `projectId` and
`delegatedFrom` for another local project), the Agent tool in Claude Code, `spawn_agent` in Codex.
Only where none reaches it, call the target's CLI: `claude -p`, `codex exec`, `agy -p="<prompt>"`.

## Running a delegate

- A whole gate, a browser suite or a load run runs one at a time.
- A brief for work in another repository tells the delegate to read a skill it needs there as that
  skill's `SKILL.md` file.
- Prefix every scratch file with its run: delegates share the scratchpad, and a resume guard adopts
  another run's files. Never delete scratch by a glob while a delegate runs.
- A brief's stop condition names which hits count: the consumer's tracked source
  (`git -C <repo> grep`), never reports or build output.
- A session that delegates its procedure delegates every request a person adds later too.
- Prod a quiet agent with SendMessage; never spawn a replacement. Where it is gone for good, do its
  phase yourself.
- Stop a finished delegate's task before the process it left, or it wakes to re-report everything.
  Stop a process by its PID after reading its command line, never by pattern.
- Before telling the person a background run is still working, read its log's last lines and its
  process in that turn: a monitor that ended without an event is no evidence, and a log ending in an
  API or connection error is a stopped run to relaunch.
- Attended, give the person a status after each delegate or background run you started finishes:
  its completion arrives as a notification.
- A brief for a message names the channel's skill beside the voice skill and hands over facts and
  constraints, never the channel's draft script: a brief naming only the voice skill reads as
  complete, and naming the script overrides the skill's choices. A brief whose result feeds a reply
  names that reply's thread.
- After a stall, timeout or resume, reconcile the delegate's commits and working tree against its
  report and hand back any contradiction. Before relaying a defect as fixed, sweep the repository
  for its class.
- A brief for code work asks the report to list every assertion, threshold, fixture or pinned
  expectation the run changed, each with its old and new value and the reason. One a review finds
  unlisted is a finding, whatever the suite reports.
- Before launching on a brief built from a template or a script, search the written file for
  unfilled placeholders (`{name}`, `$VAR`) and empty paths: the delegate improvises a value for
  each, and parallel delegates improvise the same one.
- Verify a claim before retracting it to a running delegate. Before asking the principal, re-read
  the delegate's instruction: decide it there, or hold the work and ask, never both.

## Roles and models

- Planner, for a job of two or more epics and the root cause of a row its implementer did not
  fix: Fable high, never higher; else Opus high.
- Implementer, per row: the Codex pin at medium where the row follows an exact spec (an API
  description, a data model, a contract, a failing test), edge cases, hostile input, a current API;
  Neon high where the result has to be found (an open spec, design, hill climbing, a bug sweep);
  else the other of the two, then Opus medium.
- Reviewer: never the row's implementer, chosen as `blind-review` says.
- Child for the browser steps a skill hands off: the Codex pin at medium; else this session.

- The session that takes a development job runs it to its end, on whatever model it runs; no other
  session coordinates it. On the planner's or the implementer's model it does that role itself;
  otherwise it hands the role over and writes no code.
- An epic is a part of the job that ships on its own. The planner, or the session where none runs,
  writes the checklist as a JSON file in the scratch folder, one row per task: `id`, `task`,
  `check` (a command or an observable result), `implementer`, `depends_on`, `status` (`open`, `pass`, `fail`).
  After that only `status` changes, and only the session changes it.
- The implementer works its row to the end: the check, the gate, a commit. A row whose check is a
  number (gate time, test runtime, mutation score, Lighthouse, a run's token cost) is worked as a
  loop: change one thing, measure again, keep the change only where the number improves; its report
  gives the number before and after.
- The session waits for the implementer in one blocking call and reads the commits and the gate's
  exit status without rerunning the gate. The reviewer reads the row's diff and its check's result.
  A blocking finding (a defect, a failed check, a broken rule) goes back to the same implementer
  thread, at most three times; other findings go into the report. A row with no blocking finding
  left is `pass`. A row still failing after the third return goes to the planner once for its root
  cause and the fix; still failing, its commits are reverted with `git revert` and it is `fail`,
  as is every row that depends on it.
- The job ends when every row is `pass` or `fail` and the gate passes on the last commit, or at a
  blocker only the person can lift. The report gives each row's status, every finding left open and
  every fallback taken. A finding the review raised in two rows, and the root cause of a row the planner had to
  fix, go to `agent-feedback` before the report.
- Probe each model with one cheap call before its first handover; on an error, take the next
  fallback.

Measured November 2026, index points from Artificial Analysis:

| Model     | Strong at                                                             | Weak at                                               |
| --------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| Fable 5.2 | plans, decomposition, the hardest bugs (62 at high)                   | dearest per task, its own usage limit                 |
| Opus 5.5  | repository questions, our rules, agents and memory, text in our voice | 48 at medium                                          |
| Neon      | long context, 60 at high at about half Opus's cost per task           | stale API knowledge, hostile-input cases, short tasks |
| Sol 6.2   | well-cut implementation tasks at about $1 each, edge cases            | records, summaries, repository questions              |

The Codex pin is whatever `.codex/config.toml` sets, a repository's own before
`~/.codex/config.toml`. Read the value there.

- Sol accepts `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. It has no `none`.
- `codex exec --model` overrides the config per invocation. Heavier one-off work goes there, not
  into the repository's pin.
- The workspace-write auto-review is `--approve-for-me`. `codex exec` with an open pipe on stdin
  waits for EOF before starting, so pass `< /dev/null` where stdin might be open.
- `startup_timeout_sec` defaults to 10s: raise it in `.codex/config.toml` for a slow-starting
  server.
- A skill's `agents/openai.yaml` is ungated: bump its `short_description` by hand in the commit that
  adds a mode.

## Human writing -> Neon

A text that leaves the session for a reader (a mail, a chat message, a post, a comment, a document
a person outside the session reads) is written by Neon, in every mailbox and channel. The session
writes itself: its own conversation
with the person, records, run reports, pre-reads, a reply of one or two sentences, and a text a
template fixes; a quote's prices, scope and terms come from the records.

One writer per run, on Neon high. In T3 Code it is a child thread on T3's Antigravity provider
(`delegate_task`), every later text sent with `t3_thread_send` to that thread. Elsewhere:
`agy --model gemini-4-neon-high --output-format json --print-timeout 600s -p="<brief>"`. The brief
tells it to write no file and to read the `voice` skill and the channel's skill,
and hands over every text the run already knows under `=== <id> ===`, each with sender and
signature, recipients, language, purpose, must and must-not facts, new message or reply with its
thread, for a mail subject and body; it asks for the texts only, under their ids. Every later text
and every revision goes to the same writer: outside T3, `agy --conversation <conversation_id>`
with the id the first call returned. Measured: about 30 s
for the first text and 25 s for each later one.

Check facts (names, dates, links, recipients, language, signature), content correctness, length,
and for a text published without release the standing approval's bans. Never phrasing or tone. On
a finding, hand it back to the writer with the concrete finding. Deliver the output verbatim,
without the id lines: no rewording, no dropped or added sentences, no re-casing, no polish. Any
text change goes through the writer.

Where Neon does not answer (no `agy`, not signed in, a capacity error after one
retry), the session writes the text itself after loading `voice`, and its report says so.

Public web research (companies, events, tools, vendors) goes to Neon high the same way, through
its `search_web` tool; before a result reaches a person, the session checks its version numbers and
dates against the cited source.

## Code work

Code work (an implementation, a bug fix, a refactor, tests, a script, a dependency update, a polish
fix) goes to its row's implementer, from the root of the repository it belongs to, every fix round to
the same thread: in T3 Code a child thread on T3's Antigravity or Codex provider (`delegate_task`),
each fix round with `t3_thread_send`. Elsewhere
`agy --model gemini-4-neon-high --output-format json --print-timeout 3600s -p="<brief>" < /dev/null`,
each fix round with `--conversation <conversation_id>`, or `codex exec` on the pin, each fix round
with `codex exec resume <session_id>`. The session keeps the conversation with the person, records,
rules, skills and research that needs our channels or records.
