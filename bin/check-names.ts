#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import ts from "typescript";
import skeleton from "../skeleton.json";
import { renderGuides } from "../lib/guides.ts";
import { moduleFunctionNames } from "../lib/module-function-names.ts";
import { oxlintConfig, oxlintFiles } from "../lib/oxlint.ts";
import { finish, repoRoot, TEST, type Finding } from "../lib/repo.ts";

const frameworkNames = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
  "getStaticPaths",
  "prerender",
  "onRequest",
  "default",
  "loader",
  "action",
  "meta",
  "generateMetadata",
  "generateStaticParams",
  "setup",
  "teardown",
  "fetch",
  "scheduled",
]);
const verbatimCopies = new Set(skeleton.same);
const home = realpathSync(join(import.meta.dir, ".."));
const root = realpathSync(repoRoot());
const started = performance.now();

const files = lstatSync(join(root, oxlintConfig), { throwIfNoEntry: false })
  ? oxlintFiles(root)
  : [];
const declared = new Map<string, [string, ...string[]]>();
for (const file of files.sort()) {
  if (
    !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) ||
    TEST.test(file) ||
    /(?:\.d\.[cm]?ts$|\.min\.|\.stories\.)/.test(basename(file)) ||
    /(?:^|\/)(?:dist|vendor|node_modules|public)\//.test(file)
  )
    continue;
  // The skeleton copies these sources into repositories that run them without this package's lib/.
  // An installed verbatim copy has the same text as its source.
  if (root === home && /^(?:template|template-catalog)\//.test(file)) continue;
  const text = readFileSync(join(root, file));
  if (verbatimCopies.has(file) && text.equals(readFileSync(join(home, "template", file)))) continue;
  const source = ts.createSourceFile(file, text.toString(), ts.ScriptTarget.Latest);
  for (const name of new Set(moduleFunctionNames(source))) {
    if (frameworkNames.has(name)) continue;
    const paths = declared.get(name);
    if (paths) paths.push(file);
    else declared.set(name, [file]);
  }
}
const findings: Finding[] = [];
for (const [name, [path, ...others]] of declared)
  if (others.length)
    findings.push({
      check: "names",
      path,
      text: "",
      message: `function \`${name}\` is also declared in ${others.join(", ")}`,
    });
finish(
  "names",
  findings,
  started,
  findings.length ? renderGuides(["duplicate-function-name"]) : "",
);
