# This catch can return without inspecting the error.

When a catch ignores the error, an unexpected failure looks like an ordinary missing value.

Find the fix: check for the expected condition before the call. When the API only signals that condition by throwing, match its error code, name, or class and rethrow every other error. Test that an unexpected error surfaces.

No fix: binding an unused error, adding a dummy read, or moving the same blanket fallback into another handler.
