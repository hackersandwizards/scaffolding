/** Returns `value` narrowed to non-null, or throws an Error naming `what` when null or undefined. */
export function defined<T>(value: T | null | undefined, what: string): T;
