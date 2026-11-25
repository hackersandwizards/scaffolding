# A comment containing a task marker leaves untracked work in the source code.

Comments containing `todo`, `fixme`, `xxx`, or `hack` in any letter case record unfinished work with no owner and no due date.

Find the fix: separate tasks from limitations. A limitation is a decision someone made where the code is complete without the missing part; write it as a factual comment without the marker word. Anything the code still needs is a task and must leave the code. Either complete the task now and delete the comment, or record it in the project's issue tracker and delete the comment so none of those four words remain.

No fix: renaming the marker to `NOTE`, rewording unfinished work as a limitation, or deleting the comment without completing or recording the task.
