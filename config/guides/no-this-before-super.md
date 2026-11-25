# Accessing `this` or `super` before calling `super()` in a derived constructor throws a `ReferenceError`.

Move the `super()` call above every reference to `this` or `super` in the constructor.
