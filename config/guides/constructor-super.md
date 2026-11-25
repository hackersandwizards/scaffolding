# This class constructor misuses `super()` and fails at run time.

Call `super()` before returning in a derived class constructor, and remove `super()` from a class without `extends`.
