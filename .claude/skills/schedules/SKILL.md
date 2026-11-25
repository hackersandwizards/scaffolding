---
name: schedules
description: Create, change, rename or review a scheduled run (its file under ~/.claude/schedules/ and the Claude Desktop or T3 task that triggers it), deciding first whether it should be a schedule at all. Use for "schedule this", "create a scheduled task", "run this daily/weekly", "change the schedule", "rename the task", "standing approval".
---

# Schedules

A schedule is one file, `~/.claude/schedules/<name>.md`, and the triggers that start it. Every
trigger carries only the line `Scheduled run <name>: read ~/.claude/schedules/<name>.md and carry it
out.`, so no skill a schedule runs depends on which scheduler started it.

1. Decide whether it needs a schedule. Only work that must notice an absence earns one.
   Deterministic work becomes a gate, and event-driven work becomes an agent the event calls. A run
   a person triggers at your request is your run, so say what it will do in the world when you ask
   for the trigger. Check: you can name the absence the schedule notices.
2. Name a skill for its function and the scheduled task for its job, with the cadence as the last
   segment (`mail-sweep-hourly`). The file, the Desktop task's id and the T3 task's title carry
   that name. A rename is a delete plus a create in every scheduler, and the new task inherits
   neither its last-run time nor its tool grants. List the tasks after the delete: an old task fires
   until deleted. Check: the name ends in the cadence, and no file, task or task directory of the
   old name remains.
3. Put the procedure in a skill the task loads, counts included, so every run of a task is
   identical: a count that seems to differ by weekday becomes one number in the skill. The file's
   frontmatter holds `name`, `description` and `cron`, the five-field cadence in local time and
   the one owner of it. The file carries only what is true because it runs on a schedule: the cadence, the working directory, the
   colleague it delegates to and the check on that colleague's report, the standing approval and
   its limit, what an empty run reports, and the ledger that dedupes across runs. A file that hands its run to
   a colleague says `Read ~/.claude/skills/schedules/hand-over.md and hand over as it says.` A file has one
   cron expression, so a cadence with two firing patterns is two schedules. A day-of-month and a
   weekday in one expression are OR'd: `22-28 * 4` fires all seven days and every Thursday, and no
   five-field expression says "last Thursday". Read each trigger's next run to confirm an
   expression, and never try extended syntax such as `4L` on a live task: one the scheduler cannot
   parse leaves the task unarmed. Where a trigger cannot express the cron, the file opens with
   `bun ~/.claude/scripts/schedule/due.ts <name>`, ends the run where it prints `not due`, and
   branches on the `hour=` and `day=` it prints, never on the wall clock. Check: the file holds no
   step the skill could hold.
4. Write the standing approval as a closed list of the outward acts and their limits, never the
   record writes, which the skill names. An act that goes out without a person's release names its
   `blind-review`. Check: every outward act the skill performs is on the list or the skill drafts
   it instead.
5. A run reading a time window starts at the earlier of its default and the window start the file
   hands it: the file runs `bun ~/.claude/scripts/schedule/last-run.ts <name>`, which reads both
   schedulers' records of finished runs, and puts `Window start: <output>` into the instruction; a file that
   starts with `due.ts` takes the value from that line's `window=`.
   The skill reads that line and names no schedule of its own. Where the script exits non-zero,
   the run takes its default and says so. The run reports how far back it reached. A file whose
   work belongs to its own day or slot says in one line that it does not catch up. Catch a missed
   run up through its scheduler (`run_scheduled_task` in Claude Desktop, "Run now" in T3), or by
   working the file in the session or a subagent of it, never in a separate `claude` process. A
   run worked by hand is in neither record. Check: the skill the file runs, or else the file, names
   the window rule or the no-catch-up line.
6. Every run ends its report with its outcome, done, deferred or blocked, and the reason for
   anything but done. Check: the task text demands that line.
7. Harness, model, effort, permission mode and tool grants live on the trigger, never in the file.
   The trigger runs Claude Haiku at high effort, and the colleague the file hands the run to runs on
   Claude Opus at medium effort.
   - **Claude Desktop task.** Its prompt file, `~/.claude/scheduled-tasks/<name>/SKILL.md`, holds
     the frontmatter and the trigger line. Set model and mode in the app's edit form: the app
     rewrites `scheduled-tasks.json` from its own store and has dropped a permission mode edited
     there. Create and delete a task through the scheduled-tasks tools: a task directory written
     by hand never fires. In the listing, `cronExpression` is local time, `lastRunAt` and
     `nextRunAt` are UTC, and the rendered `schedule` string flattens a range (`0 7-20 * * *`
     reads as one time). Its tasks fire only while the app runs, and a missed run is caught up.
   - **T3 task.** Create it in Settings > Scheduled tasks: the agent tool `schedule_task` takes the
     calling thread's model. Project checkout ("Use the project checkout"), destination "One
     thread, fresh session each run", the model with its `effort` option. Triggers: "At a time"
     (HH:MM and weekdays) for a daily or weekly cron; "Every interval" in minutes, counted from the
     end of the last dispatch with no fixed minute, for an hourly window; "At a time" every day for
     a day of the month; "Once"; "On webhook". A fixed-time run more than 10 minutes late is
     dropped, not caught up, and the task shows the miss; an occurrence is skipped while an earlier
     one still waits in the thread.
     Check: the file names no harness, model, mode or grant, and every trigger's next run matches
     its cron.
