# Imported module bindings are read-only and throw at run time when reassigned.

Check whether other modules must see the updated value. If the state is shared, export a setter or update helper from the source module; copy into a local variable only after confirming other importers should not see the change.

No fix: copying into a local variable when other importers rely on seeing the update.
