---
name: git-recovery
description: >-
  Rare git cases in a checkout other sessions share: committing a path holding `[` or `*`, a file
  `git rm --cached` untracked, a case-only rename, a wrong `--amend` fold, a commit from a private
  index, reverting a Git LFS file, a killed merge, an edit another session swept into its commit,
  who authored a commit, a push after a directory rename, and a tag after a piped push. Load before
  any of these.
---

# Git recovery

- Commit a path holding `[` or `*` with `:(literal)<path>`, never `git --literal-pathspecs`, which
  exports `GIT_LITERAL_PATHSPECS=1` into the hook, so every pathspec the hook passes to git turns
  literal.
- A pathspec commit takes the working tree, so `git commit -- <path>` re-adds a file that
  `git rm --cached` only untracked, `.gitignore` notwithstanding. Move the file out of the tree for
  that commit and back afterwards.
- A case-only rename commits nothing through a pathspec where `core.ignorecase` is true: the commit
  reports success and leaves the rename staged. Rename through an intermediate name in two commits
  (`Foo` -> `foo-case` -> `foo`) and read `git ls-tree HEAD -- <dir>` afterwards.
- Repair a wrong `--amend` fold index-free with `git commit-tree` plus `git update-ref` and the
  expected old value, never `reset` or `rebase`. Abandon the repair if it races. This is the only
  use of `commit-tree`.
- A commit from a private index (`GIT_INDEX_FILE`) reads that index from the commit's parent
  immediately before writing the tree. Check: `git show --stat HEAD` lists only your paths.
- After reverting a Git LFS file with `git show HEAD:<path> > <path>`, run `git lfs checkout <path>`.
- A killed merge leaves upstream files half-written with `HEAD` unmoved. Before calling a modified
  file another session's work, compare it with the merge target:
  `git show <target>:<path> | cmp -s - <path>`.
- `git commit <path>` answering `no changes added to commit` usually means another session swept
  your edit into its own commit: find it with `git log -m -S` before editing again, since a plain
  `-S` skips merge diffs.
- The commit author is the machine's git identity for every session. An agent commit is marked only
  by its `Co-Authored-By` line, so git history never says who decided a change: that evidence is a
  message, a record body or a run transcript, and is often unrecorded.
- A push after a directory rename can pack every renamed blob again (git's sparse walk compares only changed paths): 491 objects and 39 MB for 66 new ones, which GitLab let hang. Push it with `git -c pack.useSparse=false push`.
- A pipeline exits with its last command's status: `git push ... | tail -2 && git tag vX` tags after
  a rejected push. Chain on the push itself and tag only once `git rev-parse HEAD` equals
  `origin/main`. A tag that landed off main stays put: merge `origin/main` into the tagged commit.
