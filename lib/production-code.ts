import { basename } from "node:path";
import { TEST } from "./repo.ts";

export const javaScriptOrTypeScript = /\.(?:[cm]?[jt]s|[jt]sx)$/;

export function productionCode(path: string) {
  return (
    javaScriptOrTypeScript.test(path) &&
    !TEST.test(path) &&
    !/(?:\.d\.[cm]?ts$|\.min\.|\.stories\.)/.test(basename(path)) &&
    !/(?:^|\/)(?:dist|vendor|node_modules|public)\//.test(path)
  );
}
