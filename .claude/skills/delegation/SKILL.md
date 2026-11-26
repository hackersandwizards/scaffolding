---
name: delegation
description: >-
  Hand work over between harnesses, run a delegate, and which model and effort each role runs at.
  Load before starting any delegate, before code work (an implementation, a fix, a refactor, tests,
  a script, a dependency update, a polish pass), when running or configuring Codex, or when copy
  needs writing.
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
  unlisted is a finding, whatever the suite reports. It also asks that each test the run adds is
  seen red once, the red line quoted.
- Before launching on a brief built from a template or a script, search the written file for
  unfilled placeholders (`{name}`, `$VAR`) and empty paths: the delegate improvises a value for
  each, and parallel delegates improvise the same one.
- Verify a claim before retracting it to a running delegate. Before asking the principal, re-read
  the delegate's instruction: decide it there, or hold the work and ask, never both.

## Read for the occasion

| Occasion                                                                    | Read             |
| --------------------------------------------------------------------------- | ---------------- |
| A development job or any code work; which model a role runs on; Codex flags | `development.md` |
| A text that leaves the session for a reader; public web research            | `writing.md`     |
