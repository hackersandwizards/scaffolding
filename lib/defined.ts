/** Returns `value` narrowed to non-null, or throws an Error naming `what` when null or undefined. */
export function defined<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined)
    throw new Error(`expected ${what} to be defined, got ${value}`);
  return value;
}
