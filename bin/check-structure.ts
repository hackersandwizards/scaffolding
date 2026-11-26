#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { CheckAllowEntries } from "../lib/allow-entries.ts";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import own from "../package.json";
import skeleton from "../skeleton.json";
import { brandProblem, browserTestProblem, vitestRun } from "../lib/gate-config.ts";
import { renderGuides } from "../lib/guides.ts";
import { help } from "../lib/help.ts";
import { lintOverlaps } from "../lib/lint-disjoint.ts";
import { oxlintConfig, oxlintConfiguration, oxlintRestrictionFindings } from "../lib/oxlint.ts";
import {
  printCheckFindings,
  git,
  installedCommit,
  isReason,
  jsonObject,
  listFiles,
  readPackage,
  repoRoot,
  tagCommit,
  type Finding,
} from "../lib/repo.ts";
import * as structureConfig from "../lib/structure-config.ts";

help("check-structure");
const started = performance.now();
const fix = process.argv.includes("--fix");
const root = repoRoot();
const home = join(import.meta.dir, "..");
const findings: Finding[] = [];
// Repairs run after the allow audit, so --fix never writes a path an allow entry keeps.
const repairs = new Map<Finding, () => unknown>();
const add = (path: string, message: string, text = ""): Finding => {
  const finding: Finding = { check: "structure", path, text, message };
  findings.push(finding);
  return finding;
};
const at = (path: string) => join(root, path);
const exists = (path: string) => {
  try {
    return lstatSync(at(path), { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOTDIR") throw error;
    return false;
  }
};

const pkg = readPackage(root);
// The key alone counts: a skip without a reason is the gate's to report, and --fix cannot undo a write.
if (fix && pkg.scaffolding?.skip?.structure !== undefined) {
  console.error("[check-structure] --fix writes nothing: scaffolding.skip.structure is set");
  process.exit(0);
}
// A private repository runs no confidential check, so it keeps no commit-msg hook, and is granted
// no licence, so it may have no LICENSE.
const exempt: { absent: string[]; optional: string[] } =
  pkg.scaffolding?.private === true ? skeleton.private : { absent: [], optional: [] };
for (const path of exempt.absent)
  if (exists(path))
    repairs.set(add(path, "not kept in a private repository (check-structure --fix)"), () =>
      rmSync(at(path)),
    );
for (const path of skeleton.same.filter((p) => !exempt.absent.includes(p))) {
  const template = join(home, "template", path);
  if (exists(path) && readFileSync(at(path)).equals(readFileSync(template))) continue;
  const message = exists(path)
    ? "differs from the skeleton (check-structure --fix)"
    : "missing (check-structure --fix)";
  repairs.set(add(path, message), () => {
    mkdirSync(dirname(at(path)), { recursive: true });
    copyFileSync(template, at(path));
  });
}
// Git skips a hook that is not executable, with a hint, and commits unchecked: the same bytes stored
// or checked out 100644 passed as equal.
for (const path of skeleton.same.filter((p) => p.startsWith(".githooks/"))) {
  if (!exists(path)) continue;
  const { mode, blob } = structureConfig.hookIndexMode(
    git(["ls-files", "-s", "--", `:(literal)${path}`], root).toString(),
  );
  if (statSync(at(path)).mode & 0o100 && mode !== "100644") continue;
  repairs.set(add(path, "a hook is executable (check-structure --fix)", mode ?? ""), () => {
    chmodSync(at(path), 0o755);
    // The mode alone, as for a bin file: --chmod would stage the file's uncommitted content too.
    if (mode === "100644") git(["update-index", "--cacheinfo", `100755,${blob},${path}`], root);
  });
}
// The owned file pins this version's full commit, which the check matches offline against the
// installed short SHA; only --fix asks the remote for the rest.
const commit = installedCommit(home);
for (const path of skeleton.owned) {
  if (!exists(path)) continue;
  const template = readFileSync(join(home, "template-catalog", path), "utf8").replaceAll(
    "{{version}}",
    own.version,
  );
  if (!commit) {
    add(path, "no installed commit to pin: install the package from its Git tag");
    continue;
  }
  if (structureConfig.ownedTemplateMatches(readFileSync(at(path), "utf8"), template, commit))
    continue;
  repairs.set(add(path, "differs from the skeleton (check-structure --fix)"), () =>
    writeFileSync(at(path), template.replace("{{commit}}", tagCommit(own.version, commit))),
  );
}
for (const path of skeleton.present)
  if (!exists(path) && !exempt.optional.includes(path))
    add(path, structureConfig.missingSkeletonFileMessage(path));
for (const path of skeleton.absent)
  if (exists(path))
    add(
      path,
      "not allowed by the skeleton: delete this retired file and move any needed configuration into the canonical file (.oxlintrc.json, eslint.config.js, prettier.config.js, vitest.config.ts, or bun.lock)",
    );

const lintEnabled = !isReason(pkg.scaffolding?.skip?.lint);
if (lintEnabled) {
  if (!exists(oxlintConfig))
    repairs.set(add(oxlintConfig, "missing (check-structure --fix)"), () =>
      copyFileSync(join(home, "template", oxlintConfig), at(oxlintConfig)),
    );
  else {
    try {
      for (const { message, text } of oxlintRestrictionFindings(oxlintConfiguration(root)))
        add(oxlintConfig, message, text);
    } catch (error) {
      add(oxlintConfig, (error as Error).message);
    }
  }
}

for (const [path, target] of Object.entries(skeleton.symlinks)) {
  if (!exists(path) && !exists(posix.join(posix.dirname(path), target))) continue;
  if (exists(path) && lstatSync(at(path)).isSymbolicLink() && readlinkSync(at(path)) === target)
    continue;
  const finding = add(
    path,
    `must be a symlink to ${target}: if missing, run check-structure --fix; if a regular file or wrong target exists there, remove it and create the symlink with \`ln -s ${target} ${path}\``,
  );
  if (!exists(path))
    repairs.set(finding, () => {
      mkdirSync(dirname(at(path)), { recursive: true });
      symlinkSync(target, at(path));
    });
}

const prettier = await structureConfig.loadPrettier(root);
if (!prettier) add("prettier config", "prettier not installed: bun install");
else {
  const rc: Record<string, unknown> = (await prettier.resolveConfig(at("package.json"))) ?? {};
  for (const hit of structureConfig.prettierConfigFindings(rc, skeleton.prettier))
    add(hit.path, hit.message, hit.text);
}

// A block every repository keeps alike inside a file that is otherwise its own: the skeleton's value
// at each key path; where that value is a list, each of its items, beside the repository's own,
// an item with the same `matcher` as one of the skeleton's being an older copy of it. --fix writes
// them in, formatted as the repository's prettier would.
for (const [path, keys] of Object.entries(skeleton.entries)) {
  if (!exists(path)) continue;
  const template = jsonObject(readFileSync(join(home, "template", path)));
  let file: unknown;
  try {
    file = JSON.parse(readFileSync(at(path), "utf8"));
  } catch {
    file = undefined;
  }
  const { invalidParents, differ } = structureConfig.mergeSkeletonEntries(file, template, keys);
  for (const key of invalidParents)
    add(
      path,
      `${key} sits in no JSON object: repair the JSON syntax in this file so every parent of ${key} is an object ({}), then run check-structure --fix`,
    );
  if (differ.length)
    repairs.set(
      add(path, "differs from the skeleton (check-structure --fix)", differ.join(", ")),
      async () => {
        const text = `${JSON.stringify(file, null, 2)}\n`;
        const options = { ...(await prettier?.resolveConfig(at(path))), filepath: at(path) };
        writeFileSync(at(path), prettier ? await prettier.format(text, options) : text);
      },
    );
}

if (existsSync(at("package.json"))) {
  for (const hit of structureConfig.packageManifestFindings(pkg, skeleton, own.packageManager))
    add(hit.path, hit.message, hit.text);
  const strykerConfigs = listFiles(root, false).filter(structureConfig.isStrykerConfigPath);
  const hasStryker = structureConfig.hasStrykerDependency(pkg) || strykerConfigs.length > 0;
  const ownMutationBin = root === home ? own.bin["scaffolding-mutation"] : undefined;
  if (hasStryker && !structureConfig.runsMutationWrapper(pkg.scripts?.mutation, ownMutationBin))
    add("package.json", 'set scripts.mutation to "mutation": "scaffolding-mutation"');
  for (const path of strykerConfigs)
    for (const entry of await structureConfig.mutationLineRangeEntries(
      path,
      readFileSync(at(path), "utf8"),
    ))
      add(
        path,
        "mutate must select whole files, without line ranges: remove the :start-end suffix from the mutate entry in the Stryker config so the entire file is mutated",
        entry,
      );
  // The gate stretches a test's limit under load only through this variable, and no runner reads it
  // unasked: bun takes it as a flag, vitest from its config.
  const config = pkg.scaffolding ?? {};
  const browserProblem = browserTestProblem(config);
  if (browserProblem) add("package.json", browserProblem);
  const browser = !browserProblem && config.browserTest;
  const browserEnabled = browser && !isReason(config.skip?.["browser-test"]);
  const test = browser ? `bun ${vitestRun.join(" ")}` : config.test;
  if (test && (browserEnabled || !isReason(config.skip?.test))) {
    const configs = readdirSync(root).filter((p) => /^vite(?:st)?\.config\.[cm]?[jt]s$/.test(p));
    const configTexts = configs.map((p) => readFileSync(at(p), "utf8"));
    if (!structureConfig.testTimeoutConfigured(test, pkg.scripts ?? {}, configTexts))
      add(
        "package.json",
        "scaffolding.test passes no SCAFFOLDING_TEST_TIMEOUT_MS on: bun test --timeout ${SCAFFOLDING_TEST_TIMEOUT_MS:-5000}, vitest's testTimeout read from it, or the shared Vitest base",
        test,
      );
  }
  const brand = brandProblem(pkg);
  if (brand) add("package.json", brand);
  for (const hit of structureConfig.checkStepFindings(pkg)) add(hit.path, hit.message, hit.text);
  // bun marks a `bin` file executable only as it installs the package, so one stored 100644 is not
  // executable in the checkout, in a copy or behind a link.
  const bins = structureConfig.normalizedBinPaths(pkg);
  const listed = bins.length
    ? git(["ls-files", "-s", "-z", "--", ...bins.map((p) => `:(literal)${p}`)], root)
    : "";
  for (const { mode, blob, path } of structureConfig.nonExecutableIndexEntries(listed.toString()))
    repairs.set(add(path, "a bin file is stored executable (check-structure --fix)", mode), () => {
      chmodSync(at(path), 0o755);
      // --chmod would stage the file's uncommitted content too.
      git(["update-index", "--cacheinfo", `100755,${blob},${path}`], root);
    });
  if (!isReason(pkg.scaffolding?.skip?.catalog)) {
    // An Astro app in any folder, rooted at its config's folder.
    const { configs, preset } = skeleton.catalog;
    const found = listFiles(root, false).filter((p) => configs.includes(basename(p)));
    if (
      !found.some((path) =>
        structureConfig.importsCatalogPreset(readFileSync(at(path), "utf8"), preset),
      )
    )
      add(found[0] ?? `catalog/${configs[0]}`, structureConfig.catalogPresetMissingMessage(preset));
  }
}

const hooks = spawnSync("git", ["config", "core.hooksPath"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
if (hooks !== skeleton.hooksPath)
  repairs.set(
    add(
      ".git/config",
      `core.hooksPath must be ${skeleton.hooksPath} (bun install runs prepare)`,
      hooks,
    ),
    () => git(["config", "core.hooksPath", skeleton.hooksPath], root),
  );

const left = new CheckAllowEntries(pkg, "structure").audit(findings);
if (fix)
  for (const f of left)
    try {
      await repairs.get(f)?.();
    } catch (e) {
      f.message = `${f.message}: ${(e as Error).message}`;
      repairs.delete(f);
    }
const remaining = fix ? left.filter((f) => !repairs.has(f)) : left;
if (lintEnabled && exists(oxlintConfig) && !remaining.some(({ path }) => path === oxlintConfig)) {
  try {
    remaining.push(...(await lintOverlaps(root)));
  } catch (error) {
    remaining.push({
      check: "structure",
      path: oxlintConfig,
      text: "",
      message: `could not check lint rule ownership: ${(error as Error).message}. Run bun install and verify eslint.config.js and .oxlintrc.json parse cleanly, then re-run check-structure`,
    });
  }
}
const genericFolders = structureConfig.findGenericFolders(
  git(["ls-files", "--cached", "--deduplicate", "-z"], root).toString().split("\0"),
);
for (const folder of genericFolders)
  remaining.push({
    check: "structure",
    prefix: "structure",
    path: folder,
    message: `folder named \`${posix.basename(folder)}\``,
    text: "",
  });
const footer = genericFolders.length ? renderGuides(["generic-folder"]) : "";
printCheckFindings("check-structure", remaining, started);
if (footer) process.stderr.write(footer);
process.exit(remaining.length ? 1 : (process.exitCode ?? 0));
