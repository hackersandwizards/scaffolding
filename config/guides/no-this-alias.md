# Assigning `this` to a local variable such as `const self = this` obscures how `this` is bound.

Use an arrow function so callbacks keep the enclosing `this` directly, or pass the needed property value as a parameter outside callbacks, and delete the alias.

No fix: renaming the alias, writing `(() => this)()`, or inlining `this` into a non-arrow callback.
