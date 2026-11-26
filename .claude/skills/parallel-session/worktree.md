# Shared checkout or worktree

The shared checkout is the default. Give a delegate a worktree only where the shared index costs
more than the worktree: several delegates committing in one repo at once, or a long run changing
app code that the full gate checks. Short record and document edits stay in the shared checkout.
A release (version bump and tag) while another session works in the same checkout goes from a
hand-made worktree, so it carries none of that session's unpushed work.

The gate's lock serialises runs within one checkout only: across worktrees, run one full gate at a
time.

- Before the fan-out, commit and push everything the delegates need: a worktree starts from
  `origin/main`, without this checkout's uncommitted and unpushed work.
- `isolation: worktree` creates `.claude/worktrees/<name>/` on a local branch `worktree-<name>`.
  Where `git check-ignore -q .claude/worktrees/x` fails, add `.claude/worktrees/` to the repo's
  `.gitignore` first. A linter run over the whole tree, such as `eslint .`, also lints a worktree
  there unless its config ignores the path.
- A hand-made worktree goes outside the repo with no branch:
  `git worktree add --detach <scratchpad>/<run>-wt origin/main`.
- Before the first commit in a worktree, its hooks need its dependencies: run
  `bun install --frozen-lockfile` always in a worktree the harness made, whose hook output you never
  see, and in a hand-made one where its `.githooks/post-checkout` printed an `[install]` line on
  stderr or installs nothing.
- The delegate commits in its worktree, then runs `git fetch`, `git rebase origin/main` and
  `git push origin HEAD:main`, repeating on rejection, before its run ends; in a client's repository
  it stops before the push. A rebase there runs
  the post-checkout hook on `origin/main`'s lockfile: run `bun install --frozen-lockfile` again
  before a render, measurement or gate. Where Git LFS files show as modified with no change and stop
  that rebase, `git checkout -- <path>` inside the worktree clears them. Check:
  `git log origin/main..HEAD` prints nothing.
- A release reads the version in its worktree, gates there, pushes, and tags once the push has
  landed. After a rejected push, it fetches and bumps again from the new `origin/main`.
- As soon as a delegate's work is on `main`, while the session goes on, fast-forward the shared
  checkout with `git merge --ff-only origin/main` there, since a server the person starts in it
  serves the old state until then, and remove the worktree so none outlives it:
  `git worktree remove <path>` once, inside it, `git log origin/main..HEAD` and
  `git status --porcelain` both print nothing. Delete a `worktree-<name>` branch with
  `git branch -D` once `git log origin/main..worktree-<name>` prints nothing. `git worktree remove`
  drops a clean worktree's unpushed commits without a warning. Never remove a worktree with
  `--force`, another session's included: where `git worktree remove` refuses, it holds uncommitted
  or untracked files, and each is committed, copied out or read against `origin/main` first.
