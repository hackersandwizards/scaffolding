# This declaration uses `new` on a class or `constructor` on an interface.

Check whether this type describes a class or a constructable interface. Rename a class `new` method to `constructor` to define its initialiser, or replace `constructor` inside an interface describing a constructor with a `new(...): Type` construct signature.

No fix: renaming `constructor` in an interface to an ordinary method such as `create`, leaving construction undescribed.
