---
name: polish
description: >-
  Full-repo quality pass (comment sweep, quality, performance and security review, /simplify, a second
  review, commit and push), when the user asks to polish, clean up or quality-pass the repo, and
  at the end of a session that changed several repositories, once in each with
  `since <the session's first commit there>`.
---

# Polish

Polish finds defects by reading code, instruction artifacts and memory files as written.

At the end of a session, run `dependency-updates` in each repository before phase 1, and after
phase 6 bring its root Markdown files (README, CONTRIBUTING) in line with what the code now does.

An argument narrows what each phase covers, never which phases run. Report what the scope excluded.

The argument `recent` scopes the run to everything committed since the earlier of two days back
and the start `bun ~/.claude/scripts/schedule/last-run.ts <task id>` prints for the scheduled task
running it:
`BASE=$(git log --until="<that start>" -1 --format=%H)`, then `$BASE..HEAD`. Where `BASE` is
`HEAD`, say in one line that nothing was committed in the window and stop. The argument
`since <commit>` sets `BASE` to that commit.

The argument also scopes where you hunt for defects, never which proven defects you may correct.
Once a fact is verified false, fix every live copy of it, the generator that produced them
included, in files the argument never named. The phase 1 exclusion set still binds.

## 1. Preflight

Once the repository is updated, run `git status` and record every file it reports as modified, staged, or untracked. That list is this run's exclusion set. A dirty tree does not stop the run.

Review and fix committed changes only. Never edit a file in the exclusion set: polish commits what it edits, and committing one would sweep in its author's uncommitted work. Report those files as deferred, for the next run once their author has committed.

Run the repo's own checks once and record the result: this baseline separates a pre-existing failure from one the sweep caused. A subagent reporting a red gate mid-run is usually reading another agent's half-finished edit.

## 2. Comment sweep

Subtract the exclusion set from the source files before batching: the batch agents edit directly and never see phase 1.

Fan out one subagent per directory batch, told to read the Comments section of `references/failure-modes.md` and to change comments only. Spot-check one file per batch.

Tell each batch that zero changes is an acceptable result. Before deleting a comment on a magic number, grep the file for the other numbers doing a similar job: where a sibling uses a different value, the comment is the only statement that the divergence is deliberate, so keep it.

## 3. Quality, performance, security review

Run `/code-review high` and `/security-review` over the scope first; their findings join this
phase's. `/security-review` reads the pending changes of the session's own repository, whatever its
arguments name: where those are not the scope, review the scope's diff for security by hand and
say so. In a repository with a UI, measure performance on a server the run starts itself on a
free port (Lighthouse per public page type, response and render time per app route) and report
before and after numbers for each fix in the repository's one `YYYY-MM-DD-performance.md`, in the
folder its `CLAUDE.md` names for documents, written with today's date, deleting the previous one in the same commit. Serve the before state
from a detached worktree on the commit before the fix, measure before and after back to back so each
pair shares its load, and write the 1-minute load average beside each series. Before each batch,
wait up to five minutes while that load exceeds the core count (`getconf _NPROCESSORS_ONLN`), then
measure anyway.

Fan out one subagent per module or top-level directory to review it for minimalism, design, performance and security, with the path of `references/failure-modes.md` in its prompt to read in full. Reviewers report and do not edit.

Review the instruction artifacts as their own module: `.claude/` rules, agents, and skills, plus `CLAUDE.md`. Look for a pointer to a path that no longer exists, a cap or boundary that contradicts an always-on rule, one rule stated twice inside a single skill or among the artifacts that are not skills, and any skill pointing outside its own directory at another skill, rule, agent or memory file by link or by name.

Call the prompt audit yourself, never through a reviewer's prompt: `Skill` with `skill: "claude-api"` and `args: "prompt-audit <path> <path> ..."`, naming the instruction artifacts in this run's scope. Without paths it audits the whole working directory. Its high and medium findings join this phase's and get fixed like any other. A conflict it leaves as a flag goes into the final report as a decision for the user.

Review agent memory the same way, plus index lines without a file, files without an index line, and the pairs `bun ${CLAUDE_SKILL_DIR}/memory-twins.ts` lists as duplicate or conflict. Move an instruction into the artifact that owns it. Edit only your own memory. Brief every other owner's agent with its prune list (file, lines, new home) through the Agent tool, one delegate per owner: a list only printed in the summary reaches nobody on an unattended run.

A fix to a file the sync script lists as mirrored goes into the hub copy: the sync swaps the whole directory, and no check reports the lost fix. Edit and commit in the hub, then run the sync, and read its output rather than its exit status. The sync first commits every dirty rule, mirrored skill and `statusline-command.sh` in the hub and fans them out, so read the hub's `git status --porcelain` before running it. A dirty one this run did not write defers the sync: copy the files this run committed from hub `HEAD` into this repository's mirror and report the other repositories as pending. The sync leaves a repository with unpushed commits no sync wrote, or one named with `--hold <path suffix>`, untouched and prints it as `pending:`: report those lines.

## 4. Gates

Run the /simplify skill on the accumulated diff. Apply its fixes.

Then run phase 3 again over the accumulated diff rather than the tree.

One pass of each. Name any finding you dismissed, and why, in the final summary, and print the prune lists there.

## 5. Verify

Run the repo's own checks, the gate on its own line, and read `$?`. "A gate that ran but was never read" in `references/failure-modes.md` names this phase's traps.

A failing check blocks the commit. Fix it if the sweep caused it; report it and stop if it predates the sweep. A failure traced to a file in the exclusion set is another session's half-finished edit: wait for the gate to clear, and report it and stop if it does not. Never bypass the hook to get past it.

## 6. Commit and push

Re-run `git status` and drop any file that became dirty since phase 1 without an edit of yours, and commit each batch that passes the gate.

Report each fix with the check that goes red without it, each finding left unfixed and why, the
decisions left for the user, and the gate result with the pushed commits.
