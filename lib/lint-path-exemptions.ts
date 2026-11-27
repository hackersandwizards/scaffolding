import { oxlintConfig } from "./oxlint-restrictions.ts";
import { validGlob } from "./repo-inputs.ts";
import { isObject, isReason, type Finding } from "./repo.ts";

export function lintPathExemptions(check: string, settings: unknown, findings: Finding[]) {
  const scaffolding = isObject(settings) ? settings.scaffolding : undefined;
  const exemptions =
    isObject(scaffolding) && Object.hasOwn(scaffolding, check) ? scaffolding[check] : undefined;
  if (exemptions === undefined) return [];
  const setting = `settings.scaffolding.${check}`;
  const report = (message: string) =>
    findings.push({ check, path: oxlintConfig, text: "", message });
  if (!isObject(exemptions)) {
    report(
      `${setting} must be an object mapping repository-relative globs to non-blank reason strings`,
    );
    return [];
  }
  return Object.entries(exemptions).flatMap(([pattern, reason]) => {
    const key = `${setting}[${JSON.stringify(pattern)}]`;
    if (!validGlob(pattern)) report(`${key} must be a repository-relative glob`);
    else if (!isReason(reason)) report(`${key} must be a non-blank reason string`);
    else return [new Bun.Glob(pattern)];
    return [];
  });
}
