export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON text as an object, the shape of every file read here; any other value throws, as text
 * that does not parse does. */
export function jsonObject(text: string | Buffer): Record<string, unknown> {
  const parsed: unknown = JSON.parse(`${text}`);
  if (!isObject(parsed)) throw new Error("the JSON holds no object");
  return parsed;
}

export const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");
