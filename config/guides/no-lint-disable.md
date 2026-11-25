# A directive comment silences a lint rule while leaving the underlying fault in the code.

Comments using `oxlint-disable`, `eslint-disable`, their `-line` and `-next-line` forms, or `eslint-enable` hide findings from the gate without resolving the cause.

Find the fix: delete the directive comment and run the gate. Once the comment is gone, the finding appears and that rule's guide follows the findings. Read that guide and apply its design fix until the gate passes with no directive comment. Change the shared configuration in the scaffolding package only when the rule is wrong for every file of that kind in every repository. Record the reason in the scaffolding package.

No fix: moving the disable comment to the top of the file, or turning the rule off in this repository's own lint configuration.
