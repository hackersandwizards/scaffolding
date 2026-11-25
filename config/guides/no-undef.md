# This identifier is not declared or imported in this file.

Check whether the name is a typo, a missing import, or a real runtime global. Fix the spelling or import it from its module. For a real global provided by the runtime, declare it once in the lint configuration's `env` or `globals`.

No fix: declaring a dummy variable such as `let x` or `declare const x: any`, or adding a `/* global */` comment.
