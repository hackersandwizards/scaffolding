export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function jsonObject(text: string | Buffer): Record<string, unknown> {
  const parsed: unknown = JSON.parse(`${text}`);
  if (!isObject(parsed))
    throw new Error(
      "The JSON has no top-level object, so its fields cannot be read. Supply JSON with an object at the top level.",
    );
  return parsed;
}

export const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");
