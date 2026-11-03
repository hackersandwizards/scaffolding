# Subagents

- Running unattended, say so in every subagent prompt you write. A fresh delegate inherits none of
  your context and will otherwise stop to ask.
- The colleague holding a case drafts its outbound message itself through the channel's skill,
  rather than handing the draft to the colleague who owns the channel.
- A brief yields to a rule and to the channel's skill: where they conflict, follow the rule or skill
  and name the skipped instruction in the report. A brief naming a channel lets the delegate draft
  there and never forbids it: a draft is not a send.
- Delegating never widens scope. Name the work in the prompt, and have anything the delegate judges
  to need more come back as a decision for the principal. The prompt cannot enforce this: a
  delegate's tools come from its own definition, never from the caller's.
- A delegate reviewing credential handling reasons from the source, and the prompt says so: no
  command that reads a keychain, a credential helper or a secret store. A printed value stays in a
  transcript, and only a person can rotate it.
- Delegate only work that needs little from the rest of the session and hands back a compact
  result: independent parallel paths, a blind review, or work whose context would bloat this one.
  Launch ready work within the machine's free capacity, nested and headless jobs included, and
  queue the rest. A whole test gate, a browser suite or a load run runs one at a time. Fan out as
  parallel Agent calls, never through the Workflow tool.
- A delegate's Skill tool runs in the session's start folder whatever it `cd`s to: a review of
  another repository runs `claude -p` inside that repository, and its output names that
  repository's files.
- Before fanning out a third delegate, or leaving a session running for the person's return, load
  `parallel-session`.
- Delegates in one session share its scratchpad. Prefix every scratch file with its run, and fetch
  into a directory named for the run, since a resume guard adopts files another run left.
- A delegate never runs `rm`: bypass mode still prompts for an `rm` it cannot rule out, and a
  background delegate's prompt lands on the person. It lists its scratch paths in its report, and
  you delete them with literal absolute paths. While any delegate runs, never delete scratch by a
  keep-list glob: a delegate's folder need not match the prefix you gave it.
- Check that SendMessage is available before fanning out: a fan-out you cannot prod runs serially
  in your own context. Prod a quiet agent with SendMessage for its findings and do other work
  meanwhile. Never spawn a replacement for a silent agent, and never end a turn while a phase is
  still owed its report. Where an agent is gone for good, do that phase yourself.
- A delegate's report is its Agent tool result, or for a background delegate the `<result>` of its
  own `<task-notification>`, never text in your own turn. Until it arrives the report is pending: say so, and send the delegate
  nothing built on it.
- Wait for a background command with `Monitor` and an `until` loop (30 minutes at most, 10 under
  `claude -p`), with a foreground command whose `timeout` stays within 10 minutes, or, in the
  top-level session, by starting it with `run_in_background` and waiting on its exit. A delegate
  waits inside its turn and ends it only with its result, a blocker or a question. A foreground
  `sleep` chained to a check is blocked.
- Stop a finished delegate's task before you stop the process it left running. Stopping the process
  first wakes the delegate to re-report its whole context. Leave idle entries of finished delegates alone. Read the scratch folder named in a
  process's command line before stopping it: it may be a live delegate's run. Stop a process by its own
  PID, from your launch or a `pgrep` or `lsof` line whose command line you read, never by a pattern
  such as `pkill -f`: parallel sessions run the same commands.
- A stall, a timeout or a resumed transcript means a delegate's report may be incomplete. Read its
  commits and working tree over the window, reconcile every hunk against what it said it did, count
  the files it opened against the files you assigned, and hand any contradiction back.
- A delegate reports a defect inside the window you set. Sweep the repository for the class before
  relaying it as fixed.
- Verify a claim before sending a running delegate a retraction: a late retraction lands as a
  second instruction on finished work.
- Before putting a question to a principal, re-read what you told the delegate. Decide it in the
  instruction, or hold the work and ask, never both.
- Before building or changing Claude Code artifacts (skills, rules, subagents, hooks, settings,
  MCP), consult the `claude-code-guide` agent or the official docs. A rule asserting how the system
  behaves is checked against the system before it is written and before it is leaned on.
- Add an MCP server, permission or hook at project scope (`.mcp.json` or `.claude/settings.json` in
  the folder it serves), never `settings.local.json` or user scope, unless the person names that
  scope.
