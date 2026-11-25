# This declared variable, import, or parameter is never read at run time.

Dead bindings add clutter, keep unused code alive, and hide unfinished refactors. Names starting with `_` are ignored for variables, arguments, and caught errors; a value imported or declared only for type annotations is also reported.

Find the fix: delete the unused declaration, its import, and any dead code that only feeds it. If only its type is needed, use `import type` or a type declaration. When a required signature forces keeping an unused parameter or caught error, prefix its name with `_`.

No fix: adding a leading `_` to a dead local variable, exporting a binding that no module imports, or writing `void x` or a self-assignment to fake usage.
