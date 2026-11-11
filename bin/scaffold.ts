#!/bin/sh
// 2>/dev/null; exec bun --no-env-file "$0" "$@"
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { help } from "../lib/help.ts";
import { companyRemote, installedCommit, newestTag, tagCommit } from "../lib/repo.ts";

const usage =
  "usage: scaffold <dir> [--name <package name>] [--port <port>] [--catalog-in <repo>] [--admin-in <repo>]";
help("scaffold", usage);
const dir = process.argv[2];
if (!dir || dir.startsWith("-")) {
  console.error(usage);
  process.exit(2);
}
const option = (flag: string) => {
  const at = process.argv.indexOf(flag);
  if (at === -1) return undefined;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("-")) {
    console.error(`${flag} needs a value\n${usage}`);
    process.exit(2);
  }
  return value;
};
const target = resolve(dir);
if (existsSync(target) && readdirSync(target).length) {
  console.error(`[scaffold] ${target} is not empty`);
  process.exit(1);
}
const name = option("--name") ?? basename(target);
// npm's rule for a new package name, checked before anything is written.
if (!/^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/.test(name)) {
  console.error(`[scaffold] "${name}" is no npm package name: give one with --name\n${usage}`);
  process.exit(2);
}
const port = option("--port") ?? "4600";
if (!/^\d+$/.test(port)) {
  console.error(`--port must be a number\n${usage}`);
  process.exit(2);
}
const catalogIn = option("--catalog-in");
const adminIn = option("--admin-in");
const home = join(import.meta.dir, "..");
const own = JSON.parse(readFileSync(join(home, "package.json"), "utf8"));

async function newestTagOf(repo: string): Promise<string> {
  const remote = companyRemote(repo);
  const tag = await newestTag(remote);
  if (!tag) {
    console.error(`[scaffold] no v<version> tag read from ${remote}`);
    process.exit(1);
  }
  return tag;
}
const pins: Record<string, string> = {};
if (!catalogIn) pins.brand = await newestTagOf("brand");
if (!adminIn) pins.admin = await newestTagOf("admin");
// Read before anything is written, so a failure leaves no half-made repository.
let commit = "";
try {
  if (!catalogIn) commit = tagCommit(own.version, installedCommit(home));
} catch (e) {
  console.error(`[scaffold] the Pages workflow's pin: ${(e as Error).message}`);
  process.exit(1);
}

cpSync(join(home, "template"), target, { recursive: true });
if (!catalogIn) cpSync(join(home, "template-catalog"), target, { recursive: true });
// Stored as .tmpl: as eslint.config.js it would lint this package's own template files with an
// import of this package that only resolves in a repository that installs it; the Astro config
// holds a placeholder that is no TypeScript until it is filled.
for (const file of readdirSync(target, { recursive: true, encoding: "utf8" }))
  if (file.endsWith(".tmpl")) renameSync(join(target, file), join(target, file.slice(0, -5)));
// A Git dependency installs without symlinks, so the skeleton's links are made here.
const { symlinks } = JSON.parse(readFileSync(join(home, "skeleton.json"), "utf8"));
for (const [path, link] of Object.entries<string>(symlinks)) {
  mkdirSync(dirname(join(target, path)), { recursive: true });
  symlinkSync(link, join(target, path));
}
const values: Record<string, string> = {
  name,
  // The repository's own name: the Pages path, the product and the README's title.
  repo: name.replace(/^@[^/]+\//, ""),
  // A catalog brings .astro files, which only the Astro config lints.
  eslint: catalogIn ? "eslint" : "eslint/astro",
  port,
  version: own.version,
  packageManager: own.packageManager,
  commit,
};
const filled = ["package.json", "README.md", "eslint.config.js"];
if (!catalogIn) filled.push("catalog/astro.config.ts", ".github/workflows/pages.yml");
for (const file of filled) {
  const path = join(target, file);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      if (!Object.hasOwn(values, key)) throw new Error(`${file}: no value for {{${key}}}`);
      return values[key]!;
    }),
  );
}
const pkgPath = join(target, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const company = (repo: string, tag: string) => [
  `@hackersandwizards/${repo}`,
  `git+https://github.com/hackersandwizards/${repo}.git#${tag}`,
];
// The eslint plugins come with this package, so only the tools themselves are pinned here.
// `typescript` is the TypeScript 6 API that typescript-eslint imports;
// `@typescript/native` brings `tsc` 7.
const tools = ["@types/bun", "@typescript/native", "eslint", "prettier", "typescript"];
if (!catalogIn) tools.push("astro", "astrobook", "eslint-plugin-astro", "stylelint");
// Set here, not in the template: there it would govern this package's own template files with a
// package that only resolves in a repository that installs it.
pkg.prettier = "@hackersandwizards/scaffolding/prettier";
// The bun floor and the scripts every repository shares, as this package states them for itself.
pkg.engines = { bun: own.engines.bun, ...pkg.engines };
pkg.scripts = { prepare: own.scripts.prepare, fix: own.scripts.fix, ...pkg.scripts };
pkg.devDependencies = Object.fromEntries(
  [
    ...tools.map((t) => [t, own.devDependencies[t]]),
    company("scaffolding", `v${own.version}`),
    ...Object.entries(pins).map(([repo, tag]) => company(repo, tag)),
  ].sort(([a], [b]) => a.localeCompare(b)),
);
if (catalogIn) {
  const reason = `the catalog lives in ${catalogIn}`;
  Object.assign(pkg.scaffolding.skip, { catalog: reason, styles: reason });
} else {
  Object.assign(pkg.scripts, {
    dev: "ASTRO_DEV_BACKGROUND=1 bun --bun astro dev --root catalog",
    catalog: "bun run dev",
    build: "check-lock bun --bun astro build --root catalog",
    preview: 'ASTRO_PREVIEW_BACKGROUND=1 bun --bun astro preview --root "$PWD/catalog"',
    "check:retired": "brand-retired dist",
  });
  pkg.scaffolding.check.push("check:retired");
}
if (adminIn) pkg.scaffolding.skip.admin = `the admin area lives in ${adminIn}`;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
if (!catalogIn) {
  // As text: prettier keeps a short array on one line, JSON.stringify would not.
  const tsPath = join(target, "tsconfig.json");
  const was = readFileSync(tsPath, "utf8");
  const ts = was.replace('"test/**/*.ts"]', '"test/**/*.ts", "catalog/**/*.ts"]');
  if (ts === was) throw new Error("template/tsconfig.json: no include list ending in test/**/*.ts");
  writeFileSync(tsPath, ts);
}
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: target, stdio: "inherit" });
const byHand = [
  `add ${values.repo} to the hub's sync list`,
  `create hackersandwizards/${values.repo} on GitHub and push to it`,
  ...(catalogIn ? [] : ["switch Pages on: Settings > Pages > Source: GitHub Actions"]),
];
console.log(
  [
    `${target} created.`,
    `Next, in the terminal: cd ${dir} && bun install && bun run check`,
    "Then by hand:",
    ...byHand.map((step, i) => `  ${i + 1}. ${step}`),
  ]
    .map((line) => `[scaffold] ${line}`)
    .join("\n"),
);
