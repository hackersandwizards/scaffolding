---
name: schedules
description: Create, change, rename or review a scheduled task (the desktop app's recurring runs under ~/.claude/scheduled-tasks/), deciding first whether it should be a schedule at all. Use for "schedule this", "create a scheduled task", "run this daily/weekly", "change the schedule", "rename the task", "standing approval".
---

# Schedules

1. Decide whether it needs a schedule. Only work that must notice an absence earns one.
   Deterministic work becomes a gate, and event-driven work becomes an agent the event calls. A run
   a person triggers at your request is your run, so say what it will do in the world when you ask
   for the trigger. Check: you can name the absence the schedule notices.
2. Name a skill for its function and the scheduled task for its job, with the cadence as the last
   segment (`mail-sweep-10min`). Create the task without a `title`, so the app shows that name.
   A task's identifier is immutable, so a rename is a delete plus a create, and the new
   registration inherits neither its last-run time nor its tool grants, so set the grants again.
   Diff the old and new `SKILL.md` before deleting the old task, then list the tasks: the old
   registration fires until deleted. The delete leaves the old task's directory behind: remove it
   once the listing no longer shows the task. Check: the name ends in the cadence, and the old
   directory is gone.
3. Put the procedure in a skill the task loads, counts included, so every run of a task is
   identical: a count that seems to differ by weekday becomes one number in the skill. The task
   carries only what is true because it runs on a schedule: the cadence, the working directory, the
   colleague it delegates to and the check on that colleague's report, the standing approval and
   its limit, what an empty run reports, and the ledger that dedupes across runs. A task has one
   cron expression, so a cadence with two firing patterns is two tasks. Check: the
   task file holds no step the skill could hold.
4. Write the standing approval as a closed list of the outward acts and their limits, never the
   record writes, which the skill names. Check: every outward act the skill performs is on the list
   or the skill drafts it instead.
5. A run reading a time window starts at the earlier of its default and the start
   `bun ~/.claude/scripts/schedule/last-run.ts <task id>` prints, never at the app's last-run time,
   which also stamps dispatches that never started. Where the script exits non-zero, the run takes
   its default and says so. The run reports how far back it reached. A task whose work belongs to
   its own day or slot says in one line that it does not catch up. Schedules fire only while the
   desktop app runs, and no tool fires one on demand: catch a missed run up by working the task's
   `SKILL.md` in the session or an Agent-tool subagent of it, never in a separate `claude` process.
   The app logs no such run, so `last-run.ts` does not see it. Check: the task names its window
   rule or the no-catch-up line.
6. Every run ends its report with its outcome, done, deferred or blocked, and the reason for
   anything but done. Check: the task text demands that line.
7. The model and permission mode live on the registration in the app's `scheduled-tasks.json`, the
   tool grants in the app, never in the task's `SKILL.md`. Set and change them in the app's edit
   form: the app rewrites that file from its own store and has dropped a permission mode edited
   there. Create and delete a task through the scheduled-tasks tools: a task directory written by
   hand never fires. In the listing,
   `cronExpression` is local time, `lastRunAt` and `nextRunAt` are UTC, and the rendered
   `schedule` string flattens a range (`0 7-20 * * *` reads as one time).
   Check: the task's `SKILL.md` names no model, mode or grant for its own registration.
