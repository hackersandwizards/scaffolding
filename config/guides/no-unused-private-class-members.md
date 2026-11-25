# This private `#` class field, method, or accessor is never used inside its class.

Check the class methods and tests to see whether this private member implements missing behaviour or is leftover from a refactor. Call or read it where that behaviour belongs, or delete it only after confirming it is obsolete.

No fix: adding a dummy read such as `void this.#member`, or deleting the member without checking what it was for.
