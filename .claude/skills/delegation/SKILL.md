---
name: delegation
description: >-
  Which model tier and effort to run Codex at, how Codex hands authored copy to Claude, and what
  Claude starts Codex for, when running or configuring Codex or when either side needs copy written.
---

# Delegation

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
- `startup_timeout_sec` defaults to 10s, and `.codex/config.toml` sets 60 on the slow-starting
  servers.
- A skill's `agents/openai.yaml` is ungated: bump its `short_description` by hand in the commit that
  adds a mode.

## Human writing -> Claude

Codex hands Claude every piece of authored copy the voice rules cover. An agent's own conversation
with the user (replies, questions, status, explanations, technical answers) it writes itself.

```bash
claude -p "Write the <mail/message>. Facts: sender+signature, recipients, language, purpose, must/must-not facts, new mail or reply. For mails: subject line AND body. Output only the text."
```

Check facts (names, dates, links, recipients, language, signature), content correctness, and
length. Never phrasing or tone. On a finding, call `claude -p` again with the previous text plus
the concrete finding. Deliver the output verbatim: no rewording, no dropped or added sentences, no
re-casing, no polish. Any text change goes through another `claude -p` call.

## Claude -> Codex

Claude starts Codex only for a capability Claude does not have, image generation, or as an
independent blind reviewer. Codex never authors text.

Verify what a run did with `git log`, never from its own summary.
