# Calling `obj.hasOwnProperty(key)` throws on objects created without `Object.prototype`.

Replace `obj.hasOwnProperty(key)` with `Object.hasOwn(obj, key)` so the check works safely on every object.
