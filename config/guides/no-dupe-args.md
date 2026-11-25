# Two parameters in this function share the same name, so the later argument overwrites the earlier one.

Check the function body and callers to see whether both arguments are needed or one is a typo. Give each needed parameter its real name and read it in the body, or delete the duplicate parameter and update callers.

No fix: renaming the earlier parameter while leaving it ignored in the body.
