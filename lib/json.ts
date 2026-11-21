export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function jsonObject(text: string | Buffer): Record<string, unknown> {
  const parsed: unknown = JSON.parse(`${text}`);
  if (!isObject(parsed)) throw new Error("the JSON holds no object");
  return parsed;
}

export const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");

export const ownEntry = <Value>(
  table: Readonly<Record<string, Value>> | undefined,
  key: string,
): Value | undefined => (table && Object.hasOwn(table, key) ? table[key] : undefined);
