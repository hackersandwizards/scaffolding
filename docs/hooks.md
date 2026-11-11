# Hooks and CI

Checks run locally in the git hooks and in `bun run check`. The `post-merge` and `post-checkout`
hooks run `.githooks/install` when `bun.lock` or `package.json` changed, and `post-checkout` in a
new worktree too, which has no `node_modules` (a switch away from an unborn branch that finds
`node_modules` installs nothing), saying so on stderr: `bun install --frozen-lockfile` under `check-lock` without
waiting, silent when it installs. Behind a network that never answers, an install that must
download waits with no end (a failing DNS lookup ends it within seconds), so `post-checkout`,
`post-merge`, the SessionStart hook and the MCP server's start run it with `CHECK_LOCK_RUN_S` at 60 unless set: past it
`check-lock` stops the install and frees the lock, `install` names the command to run by hand and
where, and the checkout or the merge goes on. Claude Code gives up on the server's start after
`MCP_TIMEOUT`; the bound ends an install that start left running. While a gate or build holds the
lock it installs nothing, so `node_modules` never changes under a running one, and says so on
stderr with the command to run; it names a failed install the same way. An install finding another under way (the MCP server's start and the
SessionStart hook run at once) waits for it, as `check-lock` waits for a holder running its own
command. The script runs the skeleton's copy of `check-lock` (`.githooks/check-lock.ts`), so a first
install, before `node_modules` holds the package, takes the lock as every later one does. It clears
`SCAFFOLDING_LOCKED`, so a git command a gate runs in its own checkout installs nothing beside the
gate. `bun run check` starts with the same install.

In a new worktree `post-checkout` also deletes `.githooks/post-commit` unless git tracks it: Git LFS
writes its hooks there when it checks out an LFS file ahead of `.githooks/`, git writes the hooks it
tracks over theirs, and the post-commit left behind made `git worktree remove` refuse the worktree.

After `check-confidential prepush` and Git LFS (below), a push that carries a branch (a remote ref
under `refs/heads/` and a local commit, not a deletion) runs the whole gate, `bun run check`, once over the working tree, and a red gate stops the
push; a tag alone runs none.

The pre-push hook hands the refs to `git lfs pre-push` where the push may carry LFS objects or
touch a lockable file. That is the case where the repository's LFS store holds a file (`lfs/objects`
in its Git directory, or under `lfs.storage`). It is also the case where a commit new to the remote
being pushed to changes a path whose `filter` attribute is `lfs` or that is `lockable`
(`.git/info/attributes` included). Git LFS reads the pushed commits itself, so a branch bringing LFS
files the checked-out tree lacks still sends its objects. A commit counts as new until that remote's
own tracking refs or the tips git reports for it hold it, so a push to a second remote still sends
objects only `origin` has. Any other push never starts git-lfs, which would otherwise verify locks
against the remote on every push. A `.lfsconfig` alone starts nothing: git-lfs checks locks only on
the files a push changes. Where git-lfs should run and is not on `PATH`, as under a client's
narrower `PATH`, the push is refused. So a file committed raw under an LFS path on a machine without
git-lfs is caught there. Where git-lfs runs, it decides as it does without this hook. The attributes
are read from each pushed branch's tip, by a Git older than 2.40 from the checked-out tree.

Claude Code's `SessionStart` hook runs `.githooks/session-start`: it fetches `main` into
`origin/main` within 20 s (`SCAFFOLDING_FETCH_WAIT_S`, whole seconds above 0, at most about 24 days), since an SSH remote can wait for a person to approve the key, says
how many commits `origin/main` is ahead, and runs `.githooks/install`, bounded at 60 s as above. It moves no
branch, since a fast-forward succeeds with another session's uncommitted file in the shared tree and moves `HEAD`
under it; the session merges itself. In a cloud session (`CLAUDE_CODE_REMOTE=true`), whose
checkout is its own, it switches to `main`, starting it from `origin/main` in a clone of one other
branch, and fast-forwards. It prints only what the session must
act on, since its output is the session's context. CI only builds and deploys. A
repository that publishes GitHub Pages calls the reusable workflow, which runs `bun run build` and
publishes `dist/`. The caller, `.github/workflows/pages.yml`, is owned: where it exists,
`check-structure` compares it with the skeleton's (`template-catalog/`) with this version filled in, and
`--fix` writes it, so a pin raise is `bun add` plus `check-structure --fix`. The caller grants the
workflow `pages: write` and `id-token: write`, so it names the tag's full commit, which no tag move
changes. The check reads it offline: the commit must start with the short SHA bun recorded in the
installed package's `.bun-tag`. Run from an install, `--fix` and `scaffold` read the full commit
with `git ls-remote` and refuse a tag that no longer points at the installed commit. Run from this
package's own checkout, they pin its HEAD:

```yaml
jobs:
  pages:
    uses: hackersandwizards/scaffolding/.github/workflows/pages.yml@<full commit of vX.Y.Z> # vX.Y.Z
    permissions:
      contents: read
      pages: write
      id-token: write
```
