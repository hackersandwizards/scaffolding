# This identifier is declared more than once in the same scope.

Check every read in scope to see which declaration it was meant to use. Delete the redundant declaration if both refer to one binding, or rename one and update its intended readers if they are distinct values.

No fix: renaming one declaration while leaving reads bound to the wrong variable.
