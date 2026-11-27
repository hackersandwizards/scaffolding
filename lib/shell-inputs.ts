import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { posix } from "node:path";

import { pathChunks, throwGitCommandFailure } from "./repo.ts";

const shellExtension = /\.(?:sh|bash)$/;
export const otherScript = /\.(?:[cm]?[jt]sx?|py[wz]?|rb|pl|php|lua|fish|zsh|ps1)$/;
const shebang =
  /^#![ \t]*(?:\S*\/)?(?:env[ \t]+(?:(?:-S|--split-string|[A-Za-z_][A-Za-z0-9_]*=\S*)[ \t]+)*(?:\S*\/)?)?(?:sh|bash|dash|ksh)(?=\s|$)/;

function shellShebang(text: string): boolean {
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

export const needsShellShebang = (path: string) =>
  !shellExtension.test(path) && !otherScript.test(path);

export function gitShellScripts(root: string, paths: string[], ref?: string): string[] {
  return [
    ...paths.filter((path) => shellExtension.test(path)),
    ...gitShellShebangs(root, paths.filter(needsShellShebang), ref),
  ];
}

// Read literal paths without evaluating shell expansions.
const shellWord = /(?:'[^'\n]*'|"(?:\\.|[^"\\\n])*"|\\.|[^\s;&|()<>'"\\])+/;
const sourceLine = new RegExp(
  String.raw`(?:^|[;&|({])[ \t]*(?:(?:if|then|elif|else|do|while|until|command)[ \t]+)*(?:\.|source)[ \t]+(${shellWord.source})`,
  "g",
);
const sourceDirective = new RegExp(
  String.raw`(?:^|[ \t])(source|source-path)=(${shellWord.source})`,
  "g",
);

function literalWord(word: string | undefined): string | undefined {
  if (word === undefined) return undefined;
  let value = "";
  for (const [part, single, double, escaped] of word.matchAll(
    /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)|[^"'\\]+/g,
  )) {
    if (single !== undefined) value += single;
    else if (double !== undefined) {
      if (/(^|[^\\])(?:\\\\)*[$`]/.test(double)) return;
      value += double.replace(/\\([$`"\\])/g, "$1");
    } else if (escaped !== undefined) value += escaped;
    else {
      if (/[$`*?[\]{}~]/.test(part)) return;
      value += part;
    }
  }
  return value;
}

export function parseShellSourceWords(content: string) {
  const names: (string | undefined)[] = [];
  const directories: (string | undefined)[] = [];
  for (const line of content.split("\n")) {
    const directive = /^\s*#\s*shellcheck\s+(.*)$/.exec(line)?.[1];
    if (directive !== undefined) {
      for (const [, key, word] of directive.matchAll(sourceDirective))
        (key === "source" ? names : directories).push(literalWord(word));
    } else if (!/^\s*#/.test(line)) {
      for (const [, word] of line.matchAll(sourceLine)) names.push(literalWord(word));
    }
  }
  return { names, directories };
}

export function shellSources(
  scripts: string[],
  paths: string[],
  read: (path: string) => Buffer,
): Set<string> {
  const tracked = new Set(paths);
  const pending = new Set(scripts);
  const sources = new Set<string>();
  const rc = tracked.has(".shellcheckrc") ? read(".shellcheckrc").toString() : "";
  const rcPaths = rc
    .split("\n")
    .flatMap((line) => [...line.matchAll(sourceDirective)])
    .filter(([, key]) => key === "source-path")
    .map(([, , word]) => literalWord(word));
  for (const script of pending) {
    const content = read(script).toString().replace(/\\\n/g, "");
    const { names, directories } = parseShellSourceWords(content);
    const search = [".", ...rcPaths, ...directories];
    for (const name of names) {
      if (!name || posix.isAbsolute(name)) continue;
      for (const directory of search) {
        if (!directory || posix.isAbsolute(directory)) continue;
        const base = directory.replace(/^SCRIPTDIR(?=\/|$)/, posix.dirname(script));
        const path = posix.join(base, name);
        if (!tracked.has(path)) continue;
        sources.add(path);
        pending.add(path);
      }
    }
  }
  return sources;
}

export function matchGitShellShebangs(
  stdout: string,
  wanted: ReadonlySet<string>,
  ref?: string,
): string[] {
  const scripts: string[] = [];
  for (const [, name, line, text] of stdout.matchAll(/([^\0]+)\0(\d+)\0([^\n]*)\n/g)) {
    const path = ref ? name.slice(ref.length + 1) : name;
    if (line === "1" && wanted.has(path) && shellShebang(text)) scripts.push(path);
  }
  return scripts;
}

export function gitShellShebangs(root: string, candidates: string[], ref?: string): string[] {
  const scripts: string[] = [];
  const wanted = new Set(candidates);
  for (const chunk of pathChunks(candidates)) {
    if (!chunk.length) continue;
    const r = spawnSync(
      "git",
      [
        "--literal-pathspecs",
        "grep",
        "--no-recurse-submodules",
        "-G",
        "-a",
        "-n",
        "-z",
        "-m",
        "1",
        "-e",
        "^#!",
        ref ?? "--cached",
        "--",
        ...chunk,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: Infinity },
    );
    if (r.status === 1) continue;
    if (r.status !== 0)
      throwGitCommandFailure(
        r,
        "git grep could not read shell shebangs, so shell script discovery is incomplete. Use `git status` to check the index and `git rev-parse` to verify any revision supplied to the check.",
      );
    scripts.push(...matchGitShellShebangs(r.stdout, wanted, ref));
  }
  return scripts;
}
