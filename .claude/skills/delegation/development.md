# Development

## Code work

Code work (an implementation, a bug fix, a refactor, tests, a script, a dependency update, a polish
fix) goes to its row's implementer, from the root of the repository it belongs to, every fix round to
the same thread: in T3 Code a child thread on T3's Antigravity or Codex provider (`delegate_task`),
each fix round with `t3_thread_send`. Elsewhere
`agy --model gemini-4-neon-high --output-format json --print-timeout 3600s -p="<brief>" < /dev/null`,
each fix round with `--conversation <conversation_id>`, or `codex exec` on the pin, each fix round
with `codex exec resume <session_id>`. The session keeps the conversation with the person, records,
rules, skills and research that needs our channels or records.

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
  thread, at most three times; other findings go into the report. A small finding, a few lines that
  need no design choice, the session or its subagent fixes itself. A row with no blocking finding
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
