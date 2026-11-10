#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import {
  applyAllow,
  finish,
  git,
  installedCommit,
  isReason,
  listFiles,
  readPackage,
  repoRoot,
  tagCommit,
  type Finding,
} from "../lib/repo.ts";

const started = performance.now();
const fix = process.argv.includes("--fix");
const root = repoRoot();
const home = join(import.meta.dir, "..");
const skeleton = JSON.parse(readFileSync(join(home, "skeleton.json"), "utf8"));
const own = JSON.parse(readFileSync(join(home, "package.json"), "utf8"));
const findings: Finding[] = [];
// Repairs run after applyAllow, so --fix never writes a path an allow entry keeps.
const repairs = new Map<Finding, () => void>();
const add = (path: string, message: string, text = "", repair?: () => void) => {
  const finding: Finding = { check: "structure", path, text, message };
  findings.push(finding);
  if (repair) repairs.set(finding, repair);
};
const at = (path: string) => join(root, path);
const exists = (path: string) => {
  try {
    lstatSync(at(path));
    return true;
  } catch {
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
    add(path, "not kept in a private repository (check-structure --fix)", "", () =>
      rmSync(at(path)),
    );
for (const path of (skeleton.same as string[]).filter((p) => !exempt.absent.includes(p))) {
  const template = join(home, "template", path);
  if (exists(path) && readFileSync(at(path)).equals(readFileSync(template))) continue;
  add(
    path,
    exists(path)
      ? "differs from the skeleton (check-structure --fix)"
      : "missing (check-structure --fix)",
    "",
    () => {
      mkdirSync(dirname(at(path)), { recursive: true });
      copyFileSync(template, at(path));
    },
  );
}
// Git skips a hook that is not executable, with a hint, and commits unchecked: the same bytes stored
// or checked out 100644 passed as equal.
for (const path of (skeleton.same as string[]).filter((p) => p.startsWith(".githooks/"))) {
  if (!exists(path)) continue;
  const [, mode, blob] = /^(\d+) (\S+)/.exec(
    git(["ls-files", "-s", "--", `:(literal)${path}`], root).toString(),
  ) ?? [undefined, undefined, undefined];
  if (statSync(at(path)).mode & 0o100 && mode !== "100644") continue;
  add(path, "a hook is executable (check-structure --fix)", mode ?? "", () => {
    chmodSync(at(path), 0o755);
    // The mode alone, as for a bin file: --chmod would stage the file's uncommitted content too.
    if (mode === "100644") git(["update-index", "--cacheinfo", `100755,${blob},${path}`], root);
  });
}
// The owned file pins this version's full commit, which the check matches offline against the
// installed short SHA; only --fix asks the remote for the rest.
const commit = installedCommit(home);
for (const path of skeleton.owned as string[]) {
  if (!exists(path)) continue;
  const template = readFileSync(join(home, "template-catalog", path), "utf8").replaceAll(
    "{{version}}",
    own.version,
  );
  if (!commit) {
    add(path, "no installed commit to pin: install the package from its Git tag");
    continue;
  }
  const [before = "", after = ""] = template.split("{{commit}}");
  const text = readFileSync(at(path), "utf8");
  const pinned = text.slice(before.length, text.length - after.length);
  if (
    text.startsWith(before) &&
    text.endsWith(after) &&
    /^[0-9a-f]{40}$/.test(pinned) &&
    pinned.startsWith(commit)
  )
    continue;
  add(path, "differs from the skeleton (check-structure --fix)", "", () =>
    writeFileSync(at(path), template.replace("{{commit}}", tagCommit(own.version, commit))),
  );
}
for (const path of skeleton.present as string[])
  if (!exists(path) && !exempt.optional.includes(path)) add(path, "missing");
for (const path of skeleton.absent as string[])
  if (exists(path)) add(path, "not allowed by the skeleton");

for (const [path, target] of Object.entries<string>(skeleton.symlinks)) {
  if (!exists(path) && !exists(posix.join(posix.dirname(path), target))) continue;
  if (exists(path) && lstatSync(at(path)).isSymbolicLink() && readlinkSync(at(path)) === target)
    continue;
  add(
    path,
    `must be a symlink to ${target}`,
    "",
    exists(path)
      ? undefined
      : () => {
          mkdirSync(dirname(at(path)), { recursive: true });
          symlinkSync(target, at(path));
        },
  );
}

// Prettier's own resolution, so the rules count from any config form, the shared one included.
const prettierEntry = join(root, "node_modules/prettier/index.mjs");
const prettier = await import(existsSync(prettierEntry) ? prettierEntry : "prettier").catch(
  () => undefined,
);
if (!prettier) add("prettier config", "prettier not installed: bun install");
else {
  const rc = (await prettier.resolveConfig(at("package.json"))) ?? {};
  for (const [key, value] of Object.entries(skeleton.prettier))
    if (rc[key] !== value)
      add(
        "prettier config",
        `${key} must be ${JSON.stringify(value)}`,
        `${key}: ${JSON.stringify(rc[key])}`,
      );
}

if (existsSync(at("package.json"))) {
  if (pkg.type !== skeleton.package.type)
    add("package.json", `type must be ${skeleton.package.type}`);
  if (pkg.engines?.npm !== skeleton.package["engines.npm"])
    add("package.json", `engines.npm must be ${skeleton.package["engines.npm"]}`);
  if (pkg.packageManager !== own.packageManager)
    add("package.json", `packageManager must be ${own.packageManager}`, String(pkg.packageManager));
  const surface = !isReason(pkg.scaffolding?.skip?.catalog);
  const scripts = [...skeleton.package.scripts, ...(surface ? skeleton.catalog.scripts : [])];
  for (const script of scripts as string[])
    if (!pkg.scripts?.[script]) add("package.json", `script ${script} missing`, script);
  for (const step of (pkg.scaffolding?.check ?? []).flat())
    if (!/^check:[a-z0-9][\w:-]*$/.test(step) || !pkg.scripts?.[step])
      add("package.json", "a step of scaffolding.check is a script named check:<what>", step);
  // bun marks a `bin` file executable only as it installs the package, so one stored 100644 is not
  // executable in the checkout, in a copy or behind a link.
  const bins = new Set(
    (typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {})).map((p) =>
      posix.normalize(String(p)),
    ),
  );
  const listed = bins.size
    ? git(["ls-files", "-s", "-z", "--", ...[...bins].map((p) => `:(literal)${p}`)], root)
    : "";
  for (const entry of listed.toString().split("\0").filter(Boolean)) {
    const [, mode, blob, stage, path] = /^(\d+) (\S+) (\d)\t(.*)$/s.exec(entry)!;
    // An unmerged path waits for its merge.
    if (mode === "100644" && stage === "0")
      add(path, "a bin file is stored executable (check-structure --fix)", mode, () => {
        chmodSync(at(path), 0o755);
        // --chmod would stage the file's uncommitted content too.
        git(["update-index", "--cacheinfo", `100755,${blob},${path}`], root);
      });
  }
  if (surface) {
    // An Astro app in any folder, rooted at its config's folder.
    const { configs, preset } = skeleton.catalog;
    const uses = new RegExp(`from\\s*["']${preset.replace(/[/.]/g, "\\$&")}["']`);
    const found = listFiles(root, false).filter((p) => configs.includes(basename(p)));
    if (!found.some((path) => uses.test(readFileSync(at(path), "utf8"))))
      add(
        found[0] ?? `catalog/${configs[0]}`,
        `the Astro config must use the catalog preset from ${preset}`,
      );
  }
}

const hooks = spawnSync("git", ["config", "core.hooksPath"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
if (hooks !== skeleton.hooksPath)
  add(
    ".git/config",
    `core.hooksPath must be ${skeleton.hooksPath} (bun install runs prepare)`,
    hooks,
    () => git(["config", "core.hooksPath", skeleton.hooksPath], root),
  );

const left = applyAllow(pkg, "structure", findings, true);
if (fix)
  for (const f of left)
    try {
      repairs.get(f)?.();
    } catch (e) {
      f.message = `${f.message}: ${(e as Error).message}`;
      repairs.delete(f);
    }
finish("check-structure", fix ? left.filter((f) => !repairs.has(f)) : left, started);
