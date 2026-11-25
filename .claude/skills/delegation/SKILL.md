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
- Launching a queue of several runs in an attended session, tell the person its estimated end as a
  clock time a command printed, and the time per run it rests on.
- A brief for work in another repository tells the delegate to read a skill it needs there as that
  skill's `SKILL.md` file.
- Prefix every scratch file with its run: delegates share the scratchpad, and a resume guard adopts
  another run's files. Never delete scratch by a glob while a delegate runs.
- A brief's stop condition names which hits count: the consumer's tracked source
  (`git -C <repo> grep`), never reports or build output.
- A session that delegates its procedure delegates every request a person adds later too.
- Prod a quiet agent with SendMessage; never spawn a replacement. A prod waits for the agent's next
  tool round: where its transcript (`subagents/agent-<id>.jsonl`) gains no entry within fifteen
  minutes of the prod (a prod that landed took up to nine), stop its task with TaskStop and send the
  prod again, which resumes it with its context. Where it is gone for good, do its phase
  yourself.
- Stop a finished delegate's task before the process it left, or it wakes to re-report everything.
  Stop a process by its PID after reading its command line, never by pattern.
- Before telling the person a background run is still working, read its log's last lines and its
  process in that turn: a monitor that ended without an event is no evidence, and a log ending in an
  API or connection error is a stopped run to relaunch.
- Attended, while a delegate or background run you started works, give the person a status after
  each one finishes and every 20 minutes at the latest: after each status, stop the previous timer
  with TaskStop and start `sleep 1200` as a Bash call with `run_in_background: true`, whose
  completion wakes the session.
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

## A scheduled task's delegate

A scheduled run that names this section hands its run over, waits and cleans up this way.

Where this session runs on a Haiku model, the Agent call carries `model: "opus"` and
`effort: "medium"`, or the effort the task names. On any other model it carries neither, and the
delegate runs on this session's model. A delegate reporting only `wrong model` ran on Haiku:
launch it again with those two parameters.

Add these three paragraphs to the instruction, `<scratchpad>` replaced by this session's scratchpad
path and `<task>` by the task's name:

> Your scratch folder is `<scratchpad>/<task>/`: create it first, write every scratch file there,
> never in `/tmp`, run no `rm`, and list in your report every scratch path your run created outside
> it.
>
> Wait in the foreground for every command you start in the background, and end your turn only with
> your report: the session that launched you reads the end of your turn as the end of the run.
>
> Where the model you run on is a Haiku model, do no work and report only `wrong model`.

Once the report is in and no delegate of this session still runs, delete the scratch folder and
each scratch path the report lists outside it by its literal path. Where the delegate fails or is
stopped before reporting, your report says so and names the last step its transcript reached.

To wait: the Agent call returns a launch result at once, and the report arrives later as a task
notification. Do not end your turn before it arrives: while your turn is open the scheduler holds the
task's next run (Claude Desktop skips it, T3 queues it). Once it ends, Claude Desktop starts the
next run beside the delegate, and in T3 the delegate can no longer start a child thread
(`Parent run ... is not active`). T3's `t3_background_wait` takes no subagent's id. Take the
`output_file` path from the launch result and run this foreground Bash command with
`timeout: 600000`:

```bash
m=$(readlink "<output_file>"); m=${m%.jsonl}.meta.json; n=0; if [ ! -f "$m" ]; then echo ERROR; else until jq -e '.finished == true' "$m" >/dev/null 2>&1 || [ $n -ge 48 ]; do sleep 10; n=$((n+1)); done; jq -e '.finished == true' "$m" >/dev/null 2>&1 && echo finished || echo running; fi
```

Repeat it while it prints `running`, at most six times; a result saying the command was moved to
the background counts as `running`, and you run it again in the foreground. On `finished`, the
report follows as the notification. After the sixth `running`, report that the delegate is still
running and end with outcome deferred. On `ERROR`, the wait cannot be read: end the turn and relay
the report when the notification arrives after it.

## Roles and models

| Role                                                                                         | First choice                                                                                                                                                | If unavailable                         |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Planner: a job of two or more epics, and the root cause of a row its implementer did not fix | Fable high, never higher                                                                                                                                    | Opus high                              |
| Implementer                                                                                  | per row: Neon high for hill climbing, a bug sweep and a large change; the Codex pin at medium for a well-cut task, edge cases, hostile input, a current API | the other of the two, then Opus medium |
| Reviewer                                                                                     | the other of the two at high; Opus medium in a fresh context for a change against our rules                                                                 | Opus medium                            |

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
  every fallback taken. A finding the review raised in two rows goes to `agent-feedback` before the
  report.
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
that holds the facts hands it over and checks it. The session writes itself: its own conversation
with the person, records, run reports, pre-reads, a reply of one or two sentences, and a text a
template fixes; a quote's prices, scope and terms come from the records.

One writer per run. The first text starts it on Neon high through `agy`. In T3 Code, start the
writer as a child thread on T3's Antigravity provider (`delegate_task`), whose runtime is the `agy`
CLI in ACP mode, and send every later text with `t3_thread_send` to that thread. Elsewhere:
`agy --mode auto --model gemini-4-neon-high --output-format json --print-timeout 600s
-p="<brief>"` (plan mode answers with a plan, not the
text). The brief tells it to write no file and to read the `voice` skill and the channel's skill,
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
its `search_web` tool; before a result reaches a person, Claude checks its version numbers and
dates against the cited source.

## Code work

The session hands the implementer the code work: implementation, bug fixes, refactors, tests,
scripts, dependency updates and the polish fixes, with the root of the repository the work belongs to
as working folder, through the harness's own delegation tool where it reaches the implementer: in T3
Code a child thread on T3's Antigravity or Codex provider (`delegate_task`), every fix round with
`t3_thread_send` to it. Elsewhere, from the repository root:
`agy --model gemini-4-neon-high --output-format json --print-timeout 3600s -p="<brief>" < /dev/null`,
each fix round with `--conversation <conversation_id>`, or `codex exec` with the pin, each fix round
with `codex exec resume <session_id>`. The session keeps
the conversation with the person, records, rules, skills and research that needs our channels or
records, and checks every text Neon writes.

Verify what a run did with `git log`, never from its own summary.
