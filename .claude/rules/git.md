# Git

Other sessions share this working tree and its index.

- Name the paths on `git commit` itself, `--amend` included. Never `git add -A`, `git add .` or a
  bare `git commit`: a commit without a pathspec takes whatever another session staged.
- Commit a path holding `[` or `*` with `:(literal)<path>`, never `git --literal-pathspecs`, which
  exports `GIT_LITERAL_PATHSPECS=1` into the hook, so every pathspec the hook passes to git turns
  literal.
- `git add` each new file by name, and both paths of a `git mv`, before committing. A pathspec
  skips untracked files, and naming only a rename's destination leaves the file at both paths. The
  local gate still passes, because it reads the working tree rather than the commit.
- A pathspec commit takes the working tree, so `git commit -- <path>` re-adds a file that
  `git rm --cached` only untracked, `.gitignore` notwithstanding. Move the file out of the tree for
  that commit and back afterwards.
- A case-only rename commits nothing through a pathspec where `core.ignorecase` is true: the commit
  reports success and leaves the rename staged. Rename through an intermediate name in two commits
  (`Foo` -> `foo-case` -> `foo`) and read `git ls-tree HEAD -- <dir>` afterwards.
- Name files, not the directory holding them. A file can still hold another session's uncommitted
  lines beside yours: read each path's own diff, commit the clean paths now, and leave a shared file
  while its other author's session is open.
- Before `--amend`, verify that `HEAD` is still your commit. Repair a wrong fold index-free with
  `git commit-tree` plus `git update-ref` and the expected old value, never `reset` or `rebase`.
  Abandon the repair if it races.
- Never switch a hook off: no `--no-verify`, no variable or `core.hooksPath` override that skips it,
  and no `commit-tree` outside the fold repair above. A hook failing on another session's file waits
  for that session. A hook failing a correct commit is a defect for the repository that owns it: fix
  it in this run where that is yours, else the commit waits and the report names the defect.
- A commit from a private index (`GIT_INDEX_FILE`) reads that index from the commit's parent
  immediately before writing the tree. Check: `git show --stat HEAD` lists only your paths.
- `git checkout -- <path>` and `git restore` install whatever another session staged there. Revert
  with `git show HEAD:<path> > <path>`, after reading `HEAD` for that path, since it moves while
  your run is open. For a Git LFS file, follow it with `git lfs checkout <path>`. In a file
  another session also edits, revert only your own hunks. Before reverting or countering a push,
  deploy or edit you did not order, read the other sessions' transcripts
  (`grep -rl "<sha or subject>" ~/.claude/projects/*/`) for the person's decision.
- A killed merge leaves upstream files half-written with `HEAD` unmoved. Before calling a modified
  file another session's work, compare it with the merge target:
  `git show <target>:<path> | cmp -s - <path>`.
- Commit and push each finished batch without being asked, a push that deploys included: one
  coherent unit whose checks pass. A hold on a repository's deploy lives in its goal item
  (`docs/agent-work/items/goal.md`), never in a rule.
  A gate's exit status decides the commit and push: chain them with `&&` (`bun run check > <log>
  2>&1 && git commit -- <paths>`) or read the status first, never run them behind `;` or a pipe,
  which go past a red gate.
  Stay on the current branch unless the user asks for another. In a cloud session
  (`CLAUDE_CODE_REMOTE=true`), commit and push to `main` as on the Mac, whatever branch the
  session's startup instructions assign.
- Before any work in a repository, commit, `git fetch`, `git merge origin/<default branch>`, and
  push, never `git pull`. A read-only run only fetches and reads `origin/<default branch>` with
  `git show`. Where `pgrep -x claude`, which skips your own session, finds no process whose working
  directory, read with `lsof -a -d cwd -p <pid>`, lies inside this repository, commit every change
  while the gate passes. Otherwise commit only your own, never stash, and ask the person in plain
  words only where another session's file blocks the merge. In a conflict keep both sides'
  additions, the later change winning where they contradict. A rejected push repeats the update.
  Where the merge fails, read each record you act on from `origin/<default branch>` with `git show`.
  Where the fetch fails, act on nothing outside the repository, such as mail, Qonto or the calendar,
  and say why. Unattended, an SSH remote fails: the 1Password agent cannot authenticate with nobody
  present and an LFS smudge hangs. Run git there with
  `-c url."https://github.com/".insteadOf="git@github.com:"`.
- `.git/index.lock` is another session committing. A commit holds it for seconds: wait and
  retry, and if it outlives a couple of minutes, name the owning process and report it.
  Never delete it.
- Read `HEAD` back with `git ls-tree HEAD -- <paths>` before reporting anything committed. `git
  commit <path>` answering `no changes added to commit` usually means another session swept your
  edit into its own commit: find it with `git log -m -S` before editing again,
  since a plain `-S` skips merge diffs.
- The commit author is the machine's git identity for every session. An agent commit is marked only
  by its `Co-Authored-By` line, so git history never says who decided a change: that evidence is a
  message, a record body or a run transcript, and is often unrecorded.
- Work in the shared checkout by default. A worktree, made with `git worktree add` or by a
  delegate's `isolation: worktree`, is allowed where it pays off, which `parallel-session` weighs.
  It starts from `origin/main`, so this tree's uncommitted and unpushed work is absent there. Its
  commits reach `main` within the same delegate run (`git fetch`, `git rebase origin/main`,
  `git push origin HEAD:main`). Where Git LFS files show as modified with no change and stop
  that rebase, `git checkout -- <path>` inside the worktree clears them. Never push a branch and never open a pull request. A release
  (version bump and tag) while another session works in the same checkout goes from a detached
  worktree on `origin/main` holding only your commits: read the version there, gate there, push,
  and tag once the push has landed; after a rejected push fetch and bump again from the new
  `origin/main`.
