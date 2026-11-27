/** Returns `value` narrowed to non-null, or throws an Error naming `what` when null or undefined. */
export function defined(value, what) {
  if (value === null || value === undefined)
    throw new Error(`expected ${what} to be defined, got ${value}`);
  return value;
}
