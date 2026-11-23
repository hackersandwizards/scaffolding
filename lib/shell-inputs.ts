import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";

import { pathChunks } from "./staged-paths.ts";

export const shellExtension = /\.(?:sh|bash)$/;
export const otherScript = /\.(?:[cm]?[jt]sx?|py[wz]?|rb|pl|php|lua|fish|zsh|ps1)$/;
const shebang =
  /^#![ \t]*(?:\S*\/)?(?:env[ \t]+(?:-S[ \t]+)?(?:\S*\/)?|)(?:sh|bash|dash|ksh)(?=\s|$)/;

export function shellShebang(text: string): boolean {
  return shebang.test(text.split("\n", 1)[0]);
}

export function shellInput(path: string, file: string): boolean {
  if (shellExtension.test(path)) return true;
  if (otherScript.test(path)) return false;
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(256);
    const bytes = readSync(fd, header, 0, header.length, 0);
    if (header[0] !== 35 || header[1] !== 33) return false;
    const prefix = header.toString("utf8", 0, bytes);
    return shellShebang(
      bytes < header.length || prefix.includes("\n") ? prefix : readFileSync(file, "utf8"),
    );
  } finally {
    closeSync(fd);
  }
}

export function indexedShellInputs(root: string, paths: string[]): string[] {
  const scripts = paths.filter((path) => shellExtension.test(path));
  const candidates = paths.filter((path) => !shellExtension.test(path) && !otherScript.test(path));
  for (const chunk of pathChunks(candidates)) {
    if (!chunk.length) continue;
    const r = spawnSync(
      "git",
      [
        "--literal-pathspecs",
        "grep",
        "--no-recurse-submodules",
        "-a",
        "-n",
        "-z",
        "-m",
        "1",
        "-e",
        "^#!",
        "--cached",
        "--",
        ...chunk,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: Infinity },
    );
    if (r.status === 1) continue;
    if (r.status !== 0) throw new Error("git grep could not read shell shebangs");
    for (const [, path, line, text] of r.stdout.matchAll(/([^\0]+)\0(\d+)\0([^\n]*)\n/g))
      if (line === "1" && shellShebang(text)) scripts.push(path);
  }
  return scripts;
}
