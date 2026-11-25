# This `[...]` character class contains a multi-code-point Unicode sequence that matches its pieces separately.

Add the `u` or `v` flag for single characters outside the basic plane (surrogate pairs). For a base character with a combining mark or a joined emoji sequence, replace the class with alternation of complete sequences outside `[...]`.

No fix: adding `u` alone for a combining sequence, or splitting one sequence into separate code-point alternatives such as `(?:e|\u0301)`.
