export const ownEntry = <Value>(
  table: Readonly<Record<string, Value>> | undefined,
  key: string,
): Value | undefined => (table && Object.hasOwn(table, key) ? table[key] : undefined);
