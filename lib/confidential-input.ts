import { isObject, isStrings, jsonObject } from "./json.ts";

export function parsePurgedList(text: string) {
  const { salt, hashes } = jsonObject(text);
  if (typeof salt !== "string" || !isStrings(hashes))
    throw new Error("expected a salt and a list of hashes");
  return { salt, hashes };
}

export type TermList = {
  built?: string;
  salt: string;
  maxTokens: number;
  hashes: string[];
  never?: string[];
};
export function validTermTokenLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 6;
}

export const parseTermList = (text: string): TermList | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isObject(parsed)) return undefined;
  const { built, salt, maxTokens, hashes, never } = parsed;
  return isStrings(hashes) &&
    (never === undefined || isStrings(never)) &&
    typeof salt === "string" &&
    validTermTokenLimit(maxTokens)
    ? { built: typeof built === "string" ? built : undefined, salt, maxTokens, hashes, never }
    : undefined;
};

const ENTITY = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);
const fromCode = (code: number, m: string) => (code <= 0x10ffff ? String.fromCodePoint(code) : m);
export function decodeEntity(entity: string): string {
  const value = entity.slice(1, -1);
  if (value.startsWith("#")) {
    if (/^#x/i.test(value)) return fromCode(parseInt(value.slice(2), 16), entity);
    return fromCode(parseInt(value.slice(1), 10), entity);
  }
  return ENTITY.get(value) ?? entity;
}

export const decodeEntities = (s: string) => s.replace(/&(?:#\d+|#x[\da-f]+|\w+);/gi, decodeEntity);

/** Added lines per path; `paths` are the diff's files in its order, one per `diff --git` line. */
export function addedLines(diff: string, paths: string[]) {
  const added = new Map<string, string[]>();
  let path: string | undefined;
  let file = -1;
  let hunk = false;
  for (const line of diff.split("\n")) {
    // A hunk's lines start with " ", "+", "-" or "\\", so only a file's header starts "diff --git".
    if (line.startsWith("diff --git ")) [path, hunk] = [paths[++file], false];
    else if (line.startsWith("@@")) hunk = true;
    else if (hunk && path !== undefined && line.startsWith("+")) {
      const lines = added.get(path);
      if (lines) lines.push(line.slice(1));
      else added.set(path, [line.slice(1)]);
    }
  }
  return added;
}
