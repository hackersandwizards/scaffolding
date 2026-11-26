#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import ts from "typescript";
import skeleton from "../skeleton.json";
import { renderGuides } from "../lib/guides.ts";
import { moduleFunctionNames } from "../lib/module-function-names.ts";
import { oxlintConfig, oxlintFiles, parseOxlintConfig } from "../lib/oxlint.ts";
import {
  isObject,
  isReason,
  printCheckFindings,
  repoRoot,
  TEST,
  type Finding,
} from "../lib/repo.ts";

const namesSetting = "settings.scaffolding.names";
const namesConfigFinding = (message: string): Finding => ({
  check: "names",
  path: oxlintConfig,
  text: "",
  message,
});

function namesExemptions(settings: unknown, findings: Finding[]) {
  const scaffolding = isObject(settings) ? settings.scaffolding : undefined;
  const names = isObject(scaffolding) ? scaffolding.names : undefined;
  if (names === undefined) return [];
  if (!isObject(names)) {
    findings.push(
      namesConfigFinding(
        `${namesSetting} must be an object mapping repository-relative globs to non-blank reason strings`,
      ),
    );
    return [];
  }
  return Object.entries(names).flatMap(([pattern, reason]) => {
    if (isReason(reason)) return [new Bun.Glob(pattern)];
    findings.push(
      namesConfigFinding(
        `${namesSetting}[${JSON.stringify(pattern)}] must be a non-blank reason string`,
      ),
    );
    return [];
  });
}

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

const configPath = join(root, oxlintConfig);
const findings: Finding[] = [];
const hasConfig = lstatSync(configPath, { throwIfNoEntry: false }) !== undefined;
const config = hasConfig ? parseOxlintConfig(readFileSync(configPath, "utf8")) : {};
const exemptions = namesExemptions(config.settings, findings);
const files = hasConfig && findings.length === 0 ? oxlintFiles(root) : [];
const declared = new Map<string, [string, ...string[]]>();
for (const file of files.sort()) {
  if (exemptions.some((glob) => glob.match(file))) continue;
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
for (const [name, [path, ...others]] of declared)
  if (others.length)
    findings.push({
      check: "names",
      path,
      text: "",
      message: `function \`${name}\` is also declared in ${others.join(", ")}`,
    });
const footer = findings.length ? renderGuides(["duplicate-function-name"]) : "";
printCheckFindings("names", findings, started);
if (footer) process.stderr.write(footer);
process.exit(findings.length ? 1 : (process.exitCode ?? 0));
