import { isStrings, jsonObject } from "./json.ts";

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
export const parseTermList = (text: string): TermList | undefined => {
  try {
    const { built, salt, maxTokens, hashes, never } = jsonObject(text);
    return isStrings(hashes) &&
      (never === undefined || isStrings(never)) &&
      typeof salt === "string" &&
      typeof maxTokens === "number" &&
      Number.isInteger(maxTokens) &&
      maxTokens >= 1 &&
      maxTokens <= 6
      ? { built: typeof built === "string" ? built : undefined, salt, maxTokens, hashes, never }
      : undefined;
  } catch {
    return undefined;
  }
};
const ENTITY = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);
const fromCode = (code: number, m: string) => (code <= 0x10ffff ? String.fromCodePoint(code) : m);
export const decodeEntities = (s: string) =>
  s.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (m, d?: string, x?: string, name?: string) =>
    d || x ? fromCode(parseInt(d || x || "", d ? 10 : 16), m) : (ENTITY.get(name ?? "") ?? m),
  );

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
