---
name: delegation
description: >-
  Launch, prod, stop and check a delegate (an Agent-tool subagent or a new session),
  which model tier and effort to run Codex at, how Codex hands authored copy to Claude, and what
  Claude starts Codex for: before starting any delegate, when running or configuring Codex, or when
  either side needs copy written.
---

# Delegation

## Running a Claude delegate

- Launch only while the 1-minute load (`uptime`) is at or below the core count
  (`getconf _NPROCESSORS_ONLN`): hold up to ten minutes, then launch one alone. A whole gate, a
  browser suite or a load run runs one at a time.
- Delegate to an Agent-tool subagent of the session you are in, Desktop or terminal, or to a new
  session the Desktop app starts, never to a nested `claude -p` process.
- A subagent loads the `CLAUDE.md`, rules and skills of the session's start folder only. A brief for
  work in another repository tells it to read that repository's `CLAUDE.md` and every
  `.claude/rules/*.md` first, to read a skill it needs there as that skill's `SKILL.md` file, and to
  update the checkout as that repository's git rule says before changing anything.
- Prefix every scratch file with its run: delegates share the scratchpad, and a resume guard adopts
  another run's files. Never delete scratch by a glob while a delegate runs.
- A brief's stop condition names which hits count: the consumer's tracked source
  (`git -C <repo> grep`), never reports or build output.
- A session that delegates its procedure delegates every request a person adds later too.
- Prod a quiet agent with SendMessage; never spawn a replacement. Where it is gone for good, do its
  phase yourself.
- Stop a finished delegate's task before the process it left, or it wakes to re-report everything.
  Stop a process by its PID after reading its command line, never by pattern.
- After a stall, timeout or resume, reconcile the delegate's commits and working tree against its
  report and hand back any contradiction. Before relaying a defect as fixed, sweep the repository
  for its class.
- Verify a claim before retracting it to a running delegate. Before asking the principal, re-read
  the delegate's instruction: decide it there, or hold the work and ask, never both.

## Codex model tiers

Default: whatever `.codex/config.toml` sets, a repository's own before `~/.codex/config.toml`. Each
repository pins its own model and effort for the work it holds. Read the value there.

| Pick | For |
|------|-----|
| the repository's pin | everyday work |
| gpt-6.1-sol high | planning, hard bugs, architecture, final review |

- Sol accepts `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. It has no `none`.
- `codex exec --model` overrides the config per invocation. Heavier one-off work goes there, not
  into the repository's pin.
- `--full-auto` does not exist: the workspace-write auto-review is
  `--approve-for-me`. `codex exec` with an open pipe on stdin waits for EOF before starting, so pass
  `< /dev/null` where stdin might be open.
- `startup_timeout_sec` defaults to 10s: raise it in `.codex/config.toml` for a slow-starting
  server.
- A skill's `agents/openai.yaml` is ungated: bump its `short_description` by hand in the commit that
  adds a mode.

## Human writing -> Claude

Codex hands Claude every piece of prose a human reads. An agent's own conversation
with the user (replies, questions, status, explanations, technical answers) it writes itself.

```bash
claude -p --model opus --effort high "Write the <mail/message>. Facts: sender+signature, recipients, language, purpose, must/must-not facts, new mail or reply. For mails: subject line AND body. Output only the text."
```

Check facts (names, dates, links, recipients, language, signature), content correctness, and
length. Never phrasing or tone. On a finding, call `claude -p` again with the previous text plus
the concrete finding. Deliver the output verbatim: no rewording, no dropped or added sentences, no
re-casing, no polish. Any text change goes through another `claude -p` call.

## Claude -> Codex

Claude starts Codex only for a capability Claude does not have, image generation, or as an
independent blind reviewer. Codex never authors text.

Verify what a run did with `git log`, never from its own summary.
