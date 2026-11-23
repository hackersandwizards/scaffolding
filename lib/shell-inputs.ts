import { closeSync, openSync, readFileSync, readSync } from "node:fs";

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
