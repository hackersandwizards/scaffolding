# Mirrors and sync

A hub rule or skill works in every repository and on every machine it reaches: it names no
absolute path and no file or check of another repository, only hub skills, what the reader's own
repository holds, and the Company OS channel skills a hub rule routes every repository to by that
repository's name.

A participant repository, a training repository without our `CLAUDE.md` at its root that
participants build in the training, carries no rules or skills of ours either. Its harness settings
stay, and a sweep across every repository leaves it out and says so.

The sync script, `~/.claude/scripts/sync-agent-config.sh`, says in its `GLOBAL_RULES` and `GLOBAL_SKILLS` arrays which files are mirrors, and
`FORKS` names the repo-and-skill pairs the hub does not own. Check the file you are about to edit
against all three, per file rather than once per task, and edit the hub copy. The next sync replaces a mirrored directory whole, so a repo-local file
inside a mirrored skill directory goes too, and no check reports either loss.

Before syncing, run the sync script with `--dry-run` on the committed hub: it changes no mirror and
prints an `update` line for every mirrored file or skill directory that differs from the hub. A line for a file you did not change is a hub change
not yet synced or a mirror carrying edits the hub lacks: read its diff, and copy a mirror's own
edits to the hub first, or the sync deletes them in every repo at once. A declared fork drifting
from the hub is the fork working: leave it, and never lift it into the hub.

The hub is a git repository of its own: commit the hub copy there with its paths named, then run
the sync script, which commits and pushes the mirrors in every configured repository itself. It first commits every dirty rule, mirrored skill and `statusline-command.sh` in the hub, so read the hub's `git status --porcelain` before running it. A dirty one you did not write defers the sync: copy the files you committed from hub `HEAD` into the current repository's mirror and report the other repositories as pending. Name a repository held for a reason git cannot show, such as a deploy hold, with `--hold <path suffix>`: the sync leaves it, and every repository with unpushed commits no sync wrote, untouched and prints each as `pending:`, a line the report carries.
