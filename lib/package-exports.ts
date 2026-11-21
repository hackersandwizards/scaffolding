import { posix } from "node:path";
import { exportTargets, isObject } from "./repo.ts";

/** Whether an exports key or target, with one `*` at most that crosses folders, matches a path. */
function matches(pattern: string, path: string): boolean {
  const [head, tail] = pattern.split("*");
  return tail === undefined
    ? head === path
    : path.length >= head.length + tail.length && path.startsWith(head) && path.endsWith(tail);
}

export function exported(exports: unknown, subpath: string): boolean {
  if (typeof exports === "string" || Array.isArray(exports)) return false;
  if (!isObject(exports)) return true;
  const entries = Object.entries(exports).filter(([key]) => key.startsWith("."));
  if (entries.length === 0) return false;
  const want = `./${subpath}`;
  if (!want.includes("*") && Object.hasOwn(exports, want)) return exports[want] !== null;
  const pattern = entries
    .filter(([key]) => key.indexOf("*") >= 0 && key.indexOf("*") === key.lastIndexOf("*"))
    .filter(([key]) => want.length >= key.length && matches(key, want))
    .sort(([a], [b]) => b.indexOf("*") - a.indexOf("*") || b.length - a.length)[0];
  if (pattern !== undefined) return pattern[1] !== null;
  return entries.some(
    ([key, target]) =>
      target !== null && !key.includes("*") && key.endsWith("/") && want.startsWith(key),
  );
}

/** Whether a file of the package, named by its path on disk, is the target of an export. */
export function targeted(exports: unknown, subpath: string): boolean {
  return exportTargets(exports).some((target) => matches(posix.normalize(target), subpath));
}
