import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { catalogPath } from "../catalog/path.ts";

const bin = (name: string) => join(import.meta.dir, "..", "bin", `${name}.ts`);
const made: string[] = [];
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "scaffolding-test-"));
  made.push(dir);
  return dir;
}
const sh = (cwd: string, args: string[], input?: string) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, input });

function repo(files: Record<string, string>, commit = true) {
  const dir = temp();
  sh(dir, ["init", "-q", "-b", "main"]);
  write(dir, { ".gitignore": "node_modules\n", ...files });
  if (commit) {
    sh(dir, ["add", "-A"]);
    sh(dir, ["commit", "-qm", "init"]);
  }
  return dir;
}
function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
function run(cwd: string, name: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [bin(name), ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const lines = (out: string, check: string) =>
  out.split("\n").filter((l) => l.startsWith(`[${check}]`) && !/ findings, \d+ ms$/.test(l));

const fixturePackage = {
  name: "fx",
  type: "module",
  scripts: { gen: "bun ../other/util.ts" },
  dependencies: {
    "@acme/pkg": "github:acme/pkg#v1.2.0",
    "@acme/unpinned": "github:acme/unpinned",
    "@acme/branch": "git+https://github.com/acme/branch.git#main",
    "@acme/local": "file:../other",
    registry: "^1.0.0",
  },
};
const acme = {
  "node_modules/@acme/pkg/package.json": JSON.stringify({
    name: "@acme/pkg",
    version: "1.2.0",
    exports: { "./tokens": "./tokens.ts", "./elements/*": "./elements/*" },
  }),
};

describe("check-coupling", () => {
  const fx = repo({
    "package.json": JSON.stringify(fixturePackage, null, 2),
    "src/ok.ts":
      'import { t } from "@acme/pkg/tokens";\nimport e from "@acme/pkg/elements/a.css";\nimport { y } from "./in-repo";\n',
    "src/in-repo.ts": "export const y = 1;\n",
    "src/bad-sibling.ts": 'import { x } from "../../other/util";\n',
    "src/bad-exports.ts": 'import { s } from "@acme/pkg/internal/secret.ts";\n',
    "styles/bad.css": '@import "../../other/theme.css";\n@import "@acme/pkg/internal/x.css";\n',
    "src/__tests__/a.test.ts":
      'import { x } from "../../../other/util";\nconst data = "../../../../escape";\n',
    ...acme,
  });

  test("finds each planted case and nothing in the controls", () => {
    const r = run(fx, "check-coupling");
    expect(r.code).toBe(1);
    const found = lines(r.out, "check-coupling");
    expect(found).toHaveLength(10);
    for (const want of [
      "package.json: path leaves the repository; take it from the package its owner publishes (../other/util.ts)",
      "package.json: path leaves the repository; take it from the package its owner publishes (../other)",
      "src/bad-sibling.ts: path leaves",
      "styles/bad.css: path leaves the repository; take it from the package its owner publishes (../../other/theme.css)",
      "src/bad-exports.ts: not in the exports of @acme/pkg",
      "styles/bad.css: not in the exports of @acme/pkg (@acme/pkg/internal/x.css)",
      "Git dependency not pinned to a version tag (@acme/unpinned@github:acme/unpinned)",
      "Git dependency not pinned to a version tag (@acme/branch@",
      "local path dependency (@acme/local@file:../other)",
      "src/__tests__/a.test.ts: path leaves the repository; take it from the package its owner publishes (../../../other/util)",
    ])
      expect(found.some((l) => l.includes(want))).toBe(true);
    expect(r.out).not.toContain("src/ok.ts");
    expect(r.out).not.toContain("escape");
    expect(r.out).not.toContain("registry@");
  });

  test("a Git pin that node_modules does not hold goes red", () => {
    const pinned = (installed?: string) =>
      repo({
        "package.json": JSON.stringify({ dependencies: { "@acme/pkg": "github:acme/pkg#v1.2.0" } }),
        ...(installed && {
          "node_modules/@acme/pkg/package.json": JSON.stringify({ version: installed }),
        }),
      });
    expect(run(pinned("1.2.0"), "check-coupling").code).toBe(0);
    expect(run(pinned("1.1.0"), "check-coupling").out).toContain(
      "node_modules holds 1.1.0, not the pinned 1.2.0",
    );
    expect(run(pinned(), "check-coupling").out).toContain("node_modules holds nothing");
  });

  test("checks only staged files with --staged", () => {
    const dir = repo({ "package.json": "{}", "src/old.ts": 'import "../../x";\n' });
    write(dir, { "src/new.ts": 'import "../../y";\n' });
    sh(dir, ["add", "src/new.ts"]);
    const found = lines(run(dir, "check-coupling", ["--staged"]).out, "check-coupling");
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("src/new.ts");
  });

  test("the full run judges the files the next commit adds, as the commit hook will", () => {
    const dir = repo({ "package.json": "{}", "src/gone.ts": "export {};\n" });
    write(dir, { "catalog/Type.astro": 'const BRAND = "../../node_modules/x";\n' });
    rmSync(join(dir, "src/gone.ts"));
    const want = [
      "[check-coupling] catalog/Type.astro: path leaves the repository; take it from the package its owner publishes (../../node_modules/x)",
    ];
    expect(lines(run(dir, "check-coupling").out, "check-coupling")).toEqual(want);
    sh(dir, ["add", "catalog/Type.astro"]);
    expect(lines(run(dir, "check-coupling", ["--staged"]).out, "check-coupling")).toEqual(want);
  });

  test("CSS from company packages comes only from brand's exports, the shell's only under catalog/", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "@hackersandwizards/fx" }),
      "node_modules/@hackersandwizards/brand/package.json": JSON.stringify({
        exports: { "./tokens.css": "./tokens/tokens.css" },
      }),
      "src/ok.css": '@import "@hackersandwizards/brand/tokens.css";\n@import "./own.css";\n',
      "src/own.css": "a { color: red; }\n",
      "src/self.ts": 'import "@hackersandwizards/fx/x.css";\n',
      "src/deep.astro":
        '<link rel="stylesheet" href="../node_modules/@hackersandwizards/brand/expert/expert.css" />\n',
      "src/admin.ts": 'import "@hackersandwizards/admin/site.css";\n',
      "src/shell.ts": 'import "@hackersandwizards/scaffolding/catalog/catalog.css";\n',
      "catalog/shell.ts": 'import "@hackersandwizards/scaffolding/catalog/catalog.css";\n',
      "catalog/astro.config.ts": 'export const css = ["@hackersandwizards/documents/doc.css"];\n',
      "test/a.test.ts": 'const planted = "@hackersandwizards/admin/site.css";\n',
      "src/disk.css": '@source "../node_modules/@hackersandwizards/brand/tokens/tokens.css";\n',
      "src/named.css": '@import "@hackersandwizards/brand/tokens/tokens.css";\n',
      "node_modules/@hackersandwizards/slides/package.json": JSON.stringify({
        exports: {
          "./styles/slides.css": "./styles/slides.css",
          "./styles/x.css": "./styles/x.css",
        },
        scaffolding: { styles: ["./styles/slides.css"] },
      }),
      "src/deck.css": '@import "@hackersandwizards/slides/styles/slides.css";\n',
      "src/deck-disk.ts":
        'export const sheet = "./node_modules/@hackersandwizards/slides/styles/slides.css";\n',
      "src/deck-other.css": '@import "@hackersandwizards/slides/styles/x.css";\n',
    });
    const found = lines(run(dir, "check-coupling").out, "check-coupling");
    expect(found.sort()).toEqual([
      "[check-coupling] catalog/astro.config.ts: styles come from brand's exports, an engine's scaffolding.styles or this repository (@hackersandwizards/documents/doc.css)",
      "[check-coupling] src/admin.ts: styles come from brand's exports, an engine's scaffolding.styles or this repository (@hackersandwizards/admin/site.css)",
      "[check-coupling] src/deck-other.css: styles come from brand's exports, an engine's scaffolding.styles or this repository (@hackersandwizards/slides/styles/x.css)",
      "[check-coupling] src/deep.astro: not in the exports of @hackersandwizards/brand (@hackersandwizards/brand/expert/expert.css)",
      "[check-coupling] src/named.css: not in the exports of @hackersandwizards/brand (@hackersandwizards/brand/tokens/tokens.css)",
      "[check-coupling] src/shell.ts: the catalog shell's styles load only under catalog/ (@hackersandwizards/scaffolding/catalog/catalog.css)",
    ]);
  });

  test("code reaches an installed company package through exports or bin, not a disk path", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        name: "@hackersandwizards/fx",
        scripts: { postinstall: "cp node_modules/@hackersandwizards/brand/logos/w.svg public/" },
        scaffolding: {
          allow: [
            {
              check: "coupling",
              path: "scripts/installed.ts",
              text: "node_modules/@hackersandwizards/",
              reason: "lists what bun installed",
            },
          ],
        },
      }),
      "src/logos.ts":
        "export const logo = (f: string) => `node_modules/@hackersandwizards/brand/clients/${f}`;\n",
      "src/root.ts": 'export const brand = join(root, "node_modules/@hackersandwizards/brand");\n',
      "test/story.test.ts":
        'const engine = join(ROOT, "node_modules/@hackersandwizards/slides");\n',
      "src/Page.astro": '<img src="../node_modules/@hackersandwizards/brand/logos/mark.svg" />\n',
      "src/bin.ts": 'export const server = "node_modules/.bin/mcp-fathom-server";\n',
      "src/comment.ts":
        "// node_modules/@hackersandwizards/brand\nconst a = 1; // node_modules/@hackersandwizards/brand\n/*\n  node_modules/@hackersandwizards/brand\n*/\nconst url = 'https://x.dev/a';\n",
      "src/Comment.astro":
        "<!-- node_modules/@hackersandwizards/brand -->\n{/* node_modules/@hackersandwizards/brand */}\n",
      "src/after-source.ts":
        'export const q = "node_modules/@hackersandwizards/brand/x.svg"; // @source\n',
      "src/regex.ts":
        'export const f = (p: string) => p.replace(/^\\/c\\//, "node_modules/@hackersandwizards/brand/c/");\n',
      "src/segments.ts":
        'export const dir = join(root, "node_modules", "@hackersandwizards", "brand");\n',
      "src/tailwind.ts":
        'export const css = `@source "../node_modules/@hackersandwizards/brand/elements";`;\n',
      "src/self.ts": 'export const own = "node_modules/@hackersandwizards/fx/x.svg";\n',
      "src/styles.css": '@source "../node_modules/@hackersandwizards/brand/elements";\n',
      "tools/fonts.py": 'BRAND = "node_modules/@hackersandwizards/brand/tokens/fonts"\n',
      "scripts/installed.ts": 'const dir = "node_modules/@hackersandwizards/";\n',
      "src/scope.ts": 'export const at = (n: string) => "node_modules/@hackersandwizards/" + n;\n',
      "og/template.html":
        '<!-- node_modules/@hackersandwizards/brand -->\n<link rel="stylesheet" href="../node_modules/@hackersandwizards/brand/tokens/fonts.css" />\n<style>@font-face { src: url("../node_modules/@hackersandwizards/brand/tokens/fonts/inter.woff2"); }</style>\n<img src="../node_modules/@hackersandwizards/brand/logos/lockup.svg" />\n',
      "mails/brief.json":
        '{ "src": "../node_modules/@hackersandwizards/brand/logos/avatar.png", "url": "https://x.dev/a" }\n',
      "mails/served.json": '{ "src": "../@hackersandwizards/brand/logos/avatar.png" }\n',
      "scripts/fonts.sh":
        "# node_modules/@hackersandwizards/brand\ncp node_modules/@hackersandwizards/brand/tokens/fonts/x.woff2 out/ # copy\n",
      ".github/workflows/ci.yml": "# node_modules/@hackersandwizards/brand\non: push\n",
      "docs/notes.md": "node_modules/@hackersandwizards/brand/logos\n",
    });
    const why =
      "hard-coded path into an installed package: import.meta.resolve it through the package's exports (its ./package.json for the folder), run its command from node_modules/.bin, serve a catalog asset by its package path in the preset's copy, or name the exception in scaffolding.allow";
    expect(lines(run(dir, "check-coupling").out, "check-coupling").sort()).toEqual([
      `[check-coupling] mails/brief.json: ${why} (node_modules/@hackersandwizards/brand/logos/avatar.png)`,
      `[check-coupling] og/template.html: ${why} (node_modules/@hackersandwizards/brand/logos/lockup.svg)`,
      `[check-coupling] og/template.html: ${why} (node_modules/@hackersandwizards/brand/tokens/fonts/inter.woff2)`,
      `[check-coupling] package.json: ${why} (node_modules/@hackersandwizards/brand/logos/w.svg)`,
      `[check-coupling] scripts/fonts.sh: ${why} (node_modules/@hackersandwizards/brand/tokens/fonts/x.woff2)`,
      `[check-coupling] src/Page.astro: ${why} (node_modules/@hackersandwizards/brand/logos/mark.svg)`,
      `[check-coupling] src/after-source.ts: ${why} (node_modules/@hackersandwizards/brand/x.svg)`,
      `[check-coupling] src/logos.ts: ${why} (node_modules/@hackersandwizards/brand/clients/)`,
      `[check-coupling] src/regex.ts: ${why} (node_modules/@hackersandwizards/brand/c/)`,
      `[check-coupling] src/root.ts: ${why} (node_modules/@hackersandwizards/brand)`,
      `[check-coupling] src/scope.ts: ${why} (node_modules/@hackersandwizards/)`,
      `[check-coupling] src/segments.ts: ${why} (node_modules", "@hackersandwizards)`,
      `[check-coupling] test/story.test.ts: ${why} (node_modules/@hackersandwizards/slides)`,
    ]);
  });

  test("an allow entry needs a reason and must still match", () => {
    const allow = (entries: object[]) =>
      repo({
        "package.json": JSON.stringify({ scaffolding: { allow: entries } }),
        "src/a.ts": 'import "../../x";\n',
      });
    // Its text names the path it excuses, and package.json is not flagged for it.
    const reasoned = { check: "coupling", path: "src/*.ts", text: "../../x", reason: "test" };
    expect(run(allow([reasoned]), "check-coupling").code).toBe(0);
    expect(run(allow([{ ...reasoned, reason: "" }]), "check-coupling").out).toContain(
      "allow entry without a reason",
    );
    const stale = allow([reasoned, { check: "coupling", path: "src/gone.ts", reason: "old" }]);
    expect(run(stale, "check-coupling").out).toContain("allow entry matches nothing");
  });
});

// What `bun install` would leave: this package under node_modules, so the shared configs resolve.
function install(dir: string) {
  mkdirSync(join(dir, "node_modules/@hackersandwizards"), { recursive: true });
  symlinkSync(
    join(import.meta.dir, ".."),
    join(dir, "node_modules/@hackersandwizards/scaffolding"),
  );
}

// Local stand-ins for the company remotes scaffold reads brand's and admin's newest tag from.
function remotes(tags: string[]) {
  const base = temp();
  for (const name of ["brand", "admin"]) {
    const dir = join(base, `${name}.git`);
    mkdirSync(dir);
    sh(dir, ["init", "-q", "-b", "main"]);
    sh(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
    for (const tag of tags) sh(dir, ["tag", tag]);
  }
  return `${base}/`;
}
process.env.SCAFFOLDING_GIT_BASE = remotes(["v0.9.0", "v0.10.0", "v0.2.0", "latest"]);
const ownVersion = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"))
  .version as string;

test("check-structure: a bin file is stored executable, and --fix makes it so", () => {
  const dir = repo({
    "package.json": JSON.stringify({ bin: { x: "./bin/x.ts", y: "bin/y.ts" } }),
    "bin/x.ts": "#!/usr/bin/env bun\n",
    "bin/y.ts": "#!/usr/bin/env bun\n",
    "bin/z.ts": "export {};\n",
  });
  chmodSync(join(dir, "bin/y.ts"), 0o755);
  sh(dir, ["update-index", "--chmod=+x", "bin/y.ts"]);
  const binLines = (args: string[] = []) =>
    lines(run(dir, "check-structure", args).out, "check-structure").filter((l) =>
      l.includes("bin file"),
    );
  expect(binLines()).toEqual([
    "[check-structure] bin/x.ts: a bin file is stored executable (check-structure --fix) (100644)",
  ]);
  run(dir, "check-structure", ["--fix"]);
  expect(binLines()).toEqual([]);
  expect(sh(dir, ["ls-files", "-s", "bin/x.ts"]).stdout.toString()).toStartWith("100755");
});

describe("scaffold and check-structure", () => {
  const parent = temp();
  const dir = join(parent, "demo");
  const made = run(parent, "scaffold", ["demo", "--port", "4655"]);
  install(dir);
  write(dir, { "bun.lock": "" });
  sh(dir, ["config", "core.hooksPath", ".githooks"]);

  test("a scaffolded repository passes", () => {
    expect(made.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name).toBe("demo");
    const r = run(dir, "check-structure");
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  });

  test("a full repository has its catalog and admin area, brand and admin on their newest tags", () => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.devDependencies["@hackersandwizards/brand"]).toBe(
      "github:hackersandwizards/brand#v0.10.0",
    );
    expect(pkg.devDependencies["@hackersandwizards/admin"]).toBe(
      "github:hackersandwizards/admin#v0.10.0",
    );
    expect(pkg.scaffolding.skip).toEqual({ test: "new repository: no tests yet" });
    expect(pkg.scripts.build).toBe("bun --bun astro build --root catalog");
    const config = readFileSync(join(dir, "catalog/astro.config.ts"), "utf8");
    expect(config).toContain('base: "/demo"');
    expect(config).toContain("port: 4655 }");
    expect(readFileSync(join(dir, ".github/workflows/pages.yml"), "utf8")).toContain(
      `uses: hackersandwizards/scaffolding/.github/workflows/pages.yml@v${ownVersion}\n`,
    );
    expect(readdirSync(join(dir, "docs/agent-work/items"))).toEqual(["goal.md"]);
    expect(readdirSync(join(dir, "docs/agent-work"))).toEqual(["items"]);
    expect(readFileSync(join(dir, "tsconfig.json"), "utf8")).toContain('"catalog/**/*.ts"]');
    const prettier = join(import.meta.dir, "..", "node_modules", ".bin", "prettier");
    const formatted = spawnSync(prettier, ["--check", "."], { cwd: dir, encoding: "utf8" });
    expect(`${formatted.stdout}${formatted.stderr}`).toContain("All matched files use Prettier");
    expect(formatted.status).toBe(0);
  });

  test("--catalog-in and --admin-in leave both out and the skips name where they live", () => {
    const minimal = join(parent, "minimal");
    const r = run(
      parent,
      "scaffold",
      ["minimal", "--catalog-in", "acme-private", "--admin-in", "acme-private"],
      {
        SCAFFOLDING_GIT_BASE: "/nonexistent/",
      },
    );
    expect(r.code).toBe(0);
    install(minimal);
    write(minimal, { "bun.lock": "" });
    sh(minimal, ["config", "core.hooksPath", ".githooks"]);
    const pkg = JSON.parse(readFileSync(join(minimal, "package.json"), "utf8"));
    expect(
      Object.keys(pkg.devDependencies).filter((d) => d.startsWith("@hackersandwizards/")),
    ).toEqual(["@hackersandwizards/scaffolding"]);
    expect(pkg.scaffolding.skip).toEqual({
      test: "new repository: no tests yet",
      catalog: "the catalog lives in acme-private",
      styles: "the catalog lives in acme-private",
      admin: "the admin area lives in acme-private",
    });
    const top = readdirSync(minimal);
    for (const path of ["catalog", ".github", "stylelint.config.js"])
      expect(top).not.toContain(path);
    expect(readdirSync(join(minimal, "docs/agent-work"))).toEqual([".gitkeep"]);
    expect(run(minimal, "check-structure").code).toBe(0);
  });

  test("a remote without a version tag fails scaffold", () => {
    const r = run(parent, "scaffold", ["untagged"], { SCAFFOLDING_GIT_BASE: remotes(["latest"]) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("no v<version> tag read from");
  });

  test("the owned Pages workflow: an edit goes red, --fix writes this version, absence passes", () => {
    const path = join(dir, ".github/workflows/pages.yml");
    const original = readFileSync(path, "utf8");
    write(dir, { ".github/workflows/pages.yml": original.replace(`@v${ownVersion}`, "@v0.0.1") });
    expect(lines(run(dir, "check-structure").out, "check-structure")).toEqual([
      "[check-structure] .github/workflows/pages.yml: differs from the skeleton (check-structure --fix)",
    ]);
    run(dir, "check-structure", ["--fix"]);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(run(dir, "check-structure").code).toBe(0);
    rmSync(path);
    expect(run(dir, "check-structure").code).toBe(0);
    write(dir, { ".github/workflows/pages.yml": original });
  });

  test("--fix leaves a file an allow entry keeps", () => {
    const pkgPath = join(dir, "package.json");
    const pkgText = readFileSync(pkgPath, "utf8");
    const original = readFileSync(join(dir, ".github/workflows/pages.yml"), "utf8");
    const pkg = JSON.parse(pkgText);
    pkg.scaffolding.allow = [
      { check: "structure", path: ".github/workflows/pages.yml", reason: "own workflow" },
    ];
    write(dir, {
      "package.json": JSON.stringify(pkg, null, 2),
      ".github/workflows/pages.yml": "custom\n",
    });
    run(dir, "check-structure", ["--fix"]);
    expect(readFileSync(join(dir, ".github/workflows/pages.yml"), "utf8")).toBe("custom\n");
    expect(run(dir, "check-structure").code).toBe(0);
    write(dir, { "package.json": pkgText, ".github/workflows/pages.yml": original });
  });

  test("a drifted file goes red and --fix restores it", () => {
    write(dir, { ".editorconfig": "root = true\n" });
    expect(run(dir, "check-structure").out).toContain(".editorconfig: differs from the skeleton");
    run(dir, "check-structure", ["--fix"]);
    expect(run(dir, "check-structure").code).toBe(0);
  });

  test("a forbidden file, a wrong width and the hooks path go red", () => {
    const other = join(parent, "other");
    run(parent, "scaffold", ["other"]);
    install(other);
    const pkg = JSON.parse(readFileSync(join(other, "package.json"), "utf8"));
    delete pkg.prettier;
    write(other, {
      "package.json": JSON.stringify(pkg),
      "bun.lock": "",
      "eslint.config.mjs": "",
      ".prettierrc.json": JSON.stringify({
        semi: true,
        singleQuote: false,
        trailingComma: "all",
        printWidth: 80,
      }),
    });
    const out = run(other, "check-structure").out;
    expect(out).toContain("eslint.config.mjs: not allowed by the skeleton");
    expect(out).toContain("printWidth must be 100");
    expect(out).toContain("core.hooksPath must be .githooks");
  });

  test("a repository with a surface carries the catalog; every gate step is a check:<what> script", () => {
    const other = join(parent, "surface");
    run(parent, "scaffold", ["surface", "--catalog-in", "x", "--admin-in", "x"]);
    install(other);
    write(other, { "bun.lock": "" });
    sh(other, ["config", "core.hooksPath", ".githooks"]);
    const pkg = JSON.parse(readFileSync(join(other, "package.json"), "utf8"));
    delete pkg.scaffolding.skip.catalog;
    pkg.scaffolding.check = ["brand-colours", ["check:markers", "lint"]];
    pkg.scripts["check:markers"] = "true";
    write(other, { "package.json": JSON.stringify(pkg) });
    const found = lines(run(other, "check-structure").out, "check-structure");
    expect(found.sort()).toEqual([
      "[check-structure] catalog/astro.config.ts: the Astro config must use the catalog preset from @hackersandwizards/scaffolding/catalog",
      "[check-structure] package.json: a step of scaffolding.check is a script named check:<what> (brand-colours)",
      "[check-structure] package.json: a step of scaffolding.check is a script named check:<what> (lint)",
      "[check-structure] package.json: script build missing (build)",
      "[check-structure] package.json: script catalog missing (catalog)",
      "[check-structure] package.json: script dev missing (dev)",
    ]);
    pkg.scaffolding.check = [["check:markers"]];
    Object.assign(pkg.scripts, { dev: "x", catalog: "x", build: "x" });
    write(other, {
      "package.json": JSON.stringify(pkg),
      "catalog/stories/.gitkeep": "",
      // A comment naming the preset is not a use of it.
      "catalog/astro.config.ts": "// @hackersandwizards/scaffolding/catalog\n",
    });
    expect(lines(run(other, "check-structure").out, "check-structure")).toEqual([
      "[check-structure] catalog/astro.config.ts: the Astro config must use the catalog preset from @hackersandwizards/scaffolding/catalog",
    ]);
    write(other, {
      "catalog/astro.config.ts":
        'import { catalog } from "@hackersandwizards/scaffolding/catalog";\nexport default { integrations: [catalog] };\n',
    });
    expect(run(other, "check-structure").code).toBe(0);
    // An Astro app in a subfolder keeps its stories under its own root.
    mkdirSync(join(other, "talks"));
    renameSync(join(other, "catalog/astro.config.ts"), join(other, "talks/astro.config.ts"));
    expect(lines(run(other, "check-structure").out, "check-structure")).toEqual([
      "[check-structure] talks/catalog/stories: missing: the catalog's stories live here",
    ]);
    write(other, { "talks/catalog/stories/.gitkeep": "" });
    expect(run(other, "check-structure").code).toBe(0);
  });

  test("a private repository keeps no commit-msg hook", () => {
    const other = join(parent, "private");
    run(parent, "scaffold", ["private", "--catalog-in", "x", "--admin-in", "x"]);
    install(other);
    write(other, { "bun.lock": "" });
    sh(other, ["config", "core.hooksPath", ".githooks"]);
    const pkg = JSON.parse(readFileSync(join(other, "package.json"), "utf8"));
    pkg.scaffolding.private = true;
    write(other, { "package.json": JSON.stringify(pkg) });
    expect(lines(run(other, "check-structure").out, "check-structure").sort()).toEqual([
      "[check-structure] .githooks/commit-msg: not kept in a private repository (check-structure --fix)",
    ]);
    run(other, "check-structure", ["--fix"]);
    expect(run(other, "check-structure").code).toBe(0);
    expect(existsSync(join(other, ".githooks/commit-msg"))).toBe(false);
  });

  test("a repository without package.json is reported, not a crash", () => {
    const r = run(repo({ "a.md": "a\n" }), "check-structure");
    expect(r.code).toBe(1);
    expect(r.out).toContain("[check-structure] package.json: missing");
  });

  test("a scaffolded repository passes check-coupling but for the pins bun install fetches", () => {
    expect(lines(run(dir, "check-coupling").out, "check-coupling")).toEqual([
      "[check-coupling] package.json: node_modules holds nothing, not the pinned 0.10.0: bun install (@hackersandwizards/admin@github:hackersandwizards/admin#v0.10.0)",
      "[check-coupling] package.json: node_modules holds nothing, not the pinned 0.10.0: bun install (@hackersandwizards/brand@github:hackersandwizards/brand#v0.10.0)",
    ]);
  });
});

describe("check-confidential", () => {
  const names = join(temp(), "names.txt");
  writeFileSync(names, "Acme Widgets GmbH\nJane Q Doe\nZYX\nEvery\n");
  const list = join(temp(), "list.json");
  writeFileSync(list, run(temp(), "check-confidential", ["build", names]).out);
  const env = { SCAFFOLDING_CONFIDENTIAL_TERMS: list, CI: "" };

  test("the list holds hashes, not names, drops dictionary words and carries its build time", () => {
    const text = readFileSync(list, "utf8");
    expect(text).not.toMatch(/acme|jane|zyx/i);
    expect(JSON.parse(text).hashes).toHaveLength(4);
    expect(Date.now() - Date.parse(JSON.parse(text).built)).toBeLessThan(60_000);
  });

  test("a term the public text already carries is left out, its legal-form variant too", () => {
    const pub = join(temp(), "public.txt");
    writeFileSync(pub, "<p>Our clients include Acme Widgets.</p>");
    const r = spawnSync(
      process.execPath,
      [bin("check-confidential"), "build", "-", "--public", pub],
      {
        input: "Acme Widgets GmbH\nJane Q Doe\n",
        encoding: "utf8",
      },
    );
    expect(JSON.parse(r.stdout).hashes).toHaveLength(1);
  });

  test("a staged name goes red, ordinary text stays green", () => {
    const dir = repo({ "package.json": "{}", "a.md": "nothing\n" });
    write(dir, { "a.md": "nothing\nWe met jane q doe and every ZYX team.\n" });
    sh(dir, ["add", "a.md"]);
    const found = lines(
      run(dir, "check-confidential", ["--staged"], env).out,
      "check-confidential",
    );
    expect(found.map((l) => l.replace(/.*\(/, "")).sort()).toEqual(["ZYX)", "jane q doe)"]);
    write(dir, { "a.md": "nothing\nzyx in lower case is a word here.\n" });
    sh(dir, ["add", "a.md"]);
    expect(run(dir, "check-confidential", ["--staged"], env).code).toBe(0);
  });

  test("the tree audit reads every file, and a staged finding names a non-ASCII path as written", () => {
    const dir = repo({
      "package.json": "{}",
      "a.md": "nothing\n",
      "b.md": "We met jane q doe.\n",
      "c/d.md": "Every ZYX team.\n",
    });
    const audit = lines(
      run(dir, "check-confidential", ["--tree", "HEAD"], env).out,
      "check-confidential",
    );
    expect(audit.map((l) => l.replace(/:.*\(/, " (")).sort()).toEqual([
      "[check-confidential] b.md (jane q doe)",
      "[check-confidential] c/d.md (ZYX)",
    ]);
    write(dir, { "café.md": "We met jane q doe.\n" });
    sh(dir, ["add", "café.md"]);
    sh(dir, ["config", "diff.mnemonicPrefix", "true"]);
    expect(run(dir, "check-confidential", ["--staged"], env).out).toContain(
      "[check-confidential] café.md:",
    );
  });

  test("the tree audit checks a submodule's path and fails on an object it cannot read", () => {
    const dir = repo({ "package.json": "{}", "a.md": "nothing\n" });
    const head = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
    sh(dir, ["update-index", "--add", "--cacheinfo", `160000,${head},ZYX`]);
    sh(dir, ["commit", "-qm", "sub"]);
    expect(run(dir, "check-confidential", ["--tree", "HEAD"], env).out).toContain("(ZYX)");
    const sha = sh(dir, ["rev-parse", "HEAD:a.md"]).stdout.toString().trim();
    rmSync(join(dir, ".git/objects", sha.slice(0, 2), sha.slice(2)));
    const broken = run(dir, "check-confidential", ["--tree", "HEAD"], env);
    expect(broken.out).toContain("a.md not readable");
    expect(broken.code).not.toBe(0);
  });

  test("a one-word name in capitals matches only in capitals, a dictionary word included", () => {
    const caps = join(temp(), "caps.txt");
    writeFileSync(caps, "QUUX\nBRIDGE\nWidgetco\n");
    const capsList = join(temp(), "caps.json");
    writeFileSync(capsList, run(temp(), "check-confidential", ["build", caps]).out);
    const capsEnv = { SCAFFOLDING_CONFIDENTIAL_TERMS: capsList, CI: "" };
    const dir = repo({ "package.json": "{}", "a.md": "nothing\n" });
    write(dir, { "a.md": "nothing\nQUUX and BRIDGE ship, so does widgetco.\n" });
    sh(dir, ["add", "a.md"]);
    const found = lines(
      run(dir, "check-confidential", ["--staged"], capsEnv).out,
      "check-confidential",
    );
    expect(found.map((l) => l.replace(/.*\(/, "")).sort()).toEqual([
      "BRIDGE)",
      "QUUX)",
      "widgetco)",
    ]);
    write(dir, { "a.md": "nothing\nquux, Quux, the bridge and a Bridge stay ordinary words.\n" });
    sh(dir, ["add", "a.md"]);
    expect(run(dir, "check-confidential", ["--staged"], capsEnv).code).toBe(0);
    write(dir, { "a.md": "nothing\nsee docs/quux-workshop/index.html\n" });
    sh(dir, ["add", "a.md"]);
    expect(
      lines(run(dir, "check-confidential", ["--staged"], capsEnv).out, "check-confidential"),
    ).toHaveLength(1);
  });

  test("only added lines count", () => {
    const dir = repo({ "package.json": "{}", "a.md": "Acme Widgets GmbH\n" });
    write(dir, { "a.md": "Acme Widgets GmbH\nmore\n" });
    sh(dir, ["add", "a.md"]);
    expect(run(dir, "check-confidential", ["--staged"], env).code).toBe(0);
  });

  test("the commit message is checked", () => {
    const dir = repo({ "package.json": "{}" });
    const msg = join(dir, "MSG");
    writeFileSync(msg, "fix: for Acme Widgets\n");
    expect(run(dir, "check-confidential", ["--message-file", msg], env).out).toContain(
      "(Acme Widgets)",
    );
    writeFileSync(
      msg,
      "fix\n# ------------------------ >8 ------------------------\n+Acme Widgets\n",
    );
    expect(run(dir, "check-confidential", ["--message-file", msg], env).code).toBe(0);
  });

  test("an image under docs/agent-work passes once read clean; one that cannot be read goes red", () => {
    // A decodable 1x1 PNG: OCR reads it and finds no text.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      "base64",
    );
    const dir = repo({ "package.json": "{}" });
    mkdirSync(join(dir, "docs/agent-work/review"), { recursive: true });
    writeFileSync(join(dir, "docs/agent-work/review/shot.png"), png);
    sh(dir, ["add", "docs/agent-work/review/shot.png"]);
    expect(run(dir, "check-confidential", ["--staged"], { ...env, CI: "" }).code).toBe(0);
    write(dir, { "docs/agent-work/review/broken.png": "not really a png" });
    sh(dir, ["add", "docs/agent-work/review/broken.png"]);
    const r = run(dir, "check-confidential", ["--staged"], { ...env, CI: "" });
    expect(r.out).toContain("docs/agent-work/review/broken.png: image not read");
    expect(r.code).toBe(1);
  });

  test("review findings: comment lines, file names, decomposed text and '++ ' lines count", () => {
    const dir = repo({ "package.json": "{}" });
    const msg = join(dir, "MSG");
    writeFileSync(msg, "# Acme Widgets deal\n");
    expect(run(dir, "check-confidential", ["--message-file", msg], env).code).toBe(1);
    write(dir, {
      "notes/acme-widgets.md": "x\n",
      "a.md": "Jane Q Doe".normalize("NFD") + "\n++ Acme Widgets\n",
    });
    sh(dir, ["add", "notes/acme-widgets.md", "a.md"]);
    const found = lines(
      run(dir, "check-confidential", ["--staged"], env).out,
      "check-confidential",
    );
    expect(found.some((l) => l.startsWith("[check-confidential] file names:"))).toBe(true);
    expect(found.filter((l) => l.startsWith("[check-confidential] a.md:"))).toHaveLength(2);
  });

  test("an allow entry cannot switch off the list requirement", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        scaffolding: { allow: [{ check: "confidential", reason: "everything" }] },
      }),
    });
    write(dir, { "a.md": "x\n" });
    sh(dir, ["add", "a.md"]);
    const r = run(dir, "check-confidential", ["--staged"], {
      SCAFFOLDING_CONFIDENTIAL_TERMS: "/nonexistent",
      CI: "",
    });
    expect(r.out).toContain("Refused");
    expect(r.code).toBe(1);
  });

  test("the tree audit fails an allow entry that matches nothing; a staged scan cannot tell", () => {
    const kept = { check: "confidential", path: "a.md", reason: "test" };
    const gone = { check: "confidential", path: "gone.md", reason: "old" };
    const dir = repo({
      "package.json": JSON.stringify({ scaffolding: { allow: [kept, gone] } }),
      "a.md": "We met jane q doe.\n",
    });
    const audit = lines(
      run(dir, "check-confidential", ["--tree", "HEAD"], env).out,
      "check-confidential",
    );
    expect(audit).toEqual([
      `[check-confidential] package.json: allow entry matches nothing (${JSON.stringify(gone)})`,
    ]);
    write(dir, { "b.md": "x\n" });
    sh(dir, ["add", "b.md"]);
    expect(run(dir, "check-confidential", ["--staged"], env).code).toBe(0);
  });

  test.if(process.platform === "darwin")("an image that cannot be decoded is refused", () => {
    const dir = repo({ "package.json": "{}" });
    write(dir, { "bad.png": "not an image at all" });
    sh(dir, ["add", "bad.png"]);
    const r = run(dir, "check-confidential", ["--staged"], env);
    expect(r.out).toContain("bad.png: image not read");
    expect(r.code).toBe(1);
  });

  test("a repository marked private is not checked", () => {
    const dir = repo({ "package.json": JSON.stringify({ scaffolding: { private: true } }) });
    write(dir, { "a.md": "Acme Widgets GmbH\n" });
    sh(dir, ["add", "a.md"]);
    expect(run(dir, "check-confidential", ["--staged"], env).code).toBe(0);
  });

  test("a push carrying a purged commit is refused, a clean one passes", () => {
    const remote = temp();
    sh(remote, ["init", "-q", "--bare"]);
    const dir = repo({ "package.json": "{}", "a.md": "a\n" });
    sh(dir, ["remote", "add", "origin", remote]);
    write(dir, { "b.md": "b\n" });
    sh(dir, ["add", "b.md"]);
    sh(dir, ["commit", "-qm", "purged"]);
    const purged = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
    write(dir, {
      ".confidential-purged.json": run(dir, "check-confidential", ["purged", purged]).out,
    });
    const push = (sha: string, name = "origin") =>
      spawnSync(process.execPath, [bin("check-confidential"), "prepush", name, remote], {
        cwd: dir,
        input: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
        encoding: "utf8",
      });
    const refused = push(purged);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("purged from this repository's history");
    const clean = sh(dir, ["rev-parse", "HEAD~1"]).stdout.toString().trim();
    expect(push(clean).status).toBe(0);
    // Already on origin, the commit still counts as new to a second remote.
    sh(dir, ["update-ref", "refs/remotes/origin/main", purged]);
    expect(push(purged).status).toBe(0);
    expect(push(purged, "backup").status).toBe(1);
  });

  test("prepush hands the refs to Git LFS only where the push may carry LFS content", () => {
    const stub = temp();
    const log = join(stub, "log");
    const lfs = '#!/bin/sh\n[ "$1" = version ] && exit 0\necho "$*" >> "$LFS_LOG"\nexit 3\n';
    writeFileSync(join(stub, "git-lfs"), lfs, { mode: 0o755 });
    // A PATH holding git alone, so the machine's own git-lfs stays out of reach.
    const bare = temp();
    symlinkSync(Bun.which("git")!, join(bare, "git"));
    const push = (dir: string, PATH: string, remote = "origin", old = "0".repeat(40)) => {
      const head = sh(dir, ["rev-parse", "HEAD"]).stdout.toString().trim();
      return spawnSync(process.execPath, [bin("check-confidential"), "prepush", remote, "x"], {
        cwd: dir,
        env: {
          ...process.env,
          PATH,
          LFS_LOG: log,
          GIT_EXEC_PATH: bare,
        },
        input: `refs/heads/main ${head} refs/heads/main ${old}\n`,
      }).status;
    };
    const logged = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
    const both = (dir: string, remote?: string, old?: string) => [
      push(dir, `${stub}:${bare}`, remote, old),
      push(dir, bare, remote, old),
    ];
    // Nothing of LFS: git-lfs is never started, installed or not; a .lfsconfig and an empty store
    // hold no objects.
    expect(both(repo({ "package.json": "{}" }))).toEqual([0, 0]);
    expect(both(repo({ "package.json": "{}", ".lfsconfig": "" }))).toEqual([0, 0]);
    const stored = repo({ "package.json": "{}" });
    mkdirSync(join(stored, ".git/lfs/objects/ab/cd"), { recursive: true });
    expect(both(stored)).toEqual([0, 0]);
    const moved = repo({ "package.json": "{}" });
    const elsewhere = temp();
    sh(moved, ["config", "lfs.storage", elsewhere]);
    expect(both(moved)).toEqual([0, 0]);
    expect(logged()).toBe("");
    // A store holding an object: git-lfs decides and its status is the hook's; without git-lfs the
    // push is refused.
    write(stored, { ".git/lfs/objects/ab/cd/abcd": "x" });
    expect(both(stored)).toEqual([3, 1]);
    write(elsewhere, { "objects/ab/cd/abcd": "x" });
    expect(both(moved)).toEqual([3, 1]);
    // No store, but a pushed commit changes a path under filter=lfs, committed raw where git-lfs
    // was never installed.
    const raw = repo(
      { "package.json": "{}", ".gitattributes": "*.bin filter=lfs\n", "a.bin": "x" },
      false,
    );
    const noLfs = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const rawGit = (args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
        cwd: raw,
        env: noLfs,
      });
    rawGit(["add", "-A"]);
    rawGit(["commit", "-qm", "raw"]);
    expect(existsSync(join(raw, ".git/lfs"))).toBe(false);
    expect(both(raw)).toEqual([3, 1]);
    // The same path committed before the push, already on a remote: nothing to carry.
    write(raw, { "b.md": "b\n" });
    rawGit(["add", "b.md"]);
    rawGit(["commit", "-qm", "b"]);
    sh(raw, ["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
    expect(both(raw)).toEqual([0, 0]);
    // A second remote lacks what origin holds, so the path is new there.
    expect(both(raw, "backup")).toEqual([3, 1]);
    // A push to a URL has no tracking refs: the remote's tip from the input counts instead.
    const before = sh(raw, ["rev-parse", "HEAD~1"]).stdout.toString().trim();
    expect(both(raw, "/elsewhere.git", before)).toEqual([0, 0]);
    // .git/info/attributes counts as well.
    const info = repo({ "package.json": "{}", "a.bin": "x" });
    write(info, { ".git/info/attributes": "*.bin filter=lfs\n" });
    expect(both(info)).toEqual([3, 1]);
    // A lockable path: git-lfs refuses a change to a file someone else locked, LFS or not.
    expect(
      both(repo({ "package.json": "{}", ".gitattributes": "*.psd lockable\n", "a.psd": "x" })),
    ).toEqual([3, 1]);
    expect(logged()).toBe(
      "pre-push origin x\n".repeat(3) + "pre-push backup x\n" + "pre-push origin x\n".repeat(2),
    );
  });
});

describe("check-confidential list source", () => {
  const names = join(temp(), "names.txt");
  writeFileSync(names, "Acme Widgets GmbH\n");
  const fresh = run(temp(), "check-confidential", ["build", names]).out;
  const builtDaysAgo = (days: number) =>
    JSON.stringify({
      ...JSON.parse(fresh),
      built: new Date(Date.now() - days * 864e5).toISOString(),
    });
  const stubDir = temp();
  writeFileSync(
    join(stubDir, "gh"),
    '#!/bin/sh\necho "$*" >> "$GH_STUB_LOG"\n[ "$GH_STUB" = ok ] && exec cat "$GH_STUB_FILE"\necho "HTTP 404: Not Found" >&2\nexit 1\n',
    { mode: 0o755 },
  );

  function machine(opts: {
    gh: "ok" | "deny";
    remote?: string;
    cache?: string;
    cacheDays?: number;
  }) {
    const home = temp();
    const remote = join(home, "remote.json");
    writeFileSync(remote, opts.remote ?? fresh);
    const dir = repo({ "package.json": "{}", "a.md": "a\n" });
    const cache = join(dir, "node_modules/.cache/scaffolding/confidential-terms.json");
    if (opts.cache) {
      write(dir, { "node_modules/.cache/scaffolding/confidential-terms.json": opts.cache });
      const t = (Date.now() - (opts.cacheDays ?? 0) * 864e5) / 1000;
      utimesSync(cache, t, t);
    }
    const log = join(home, "gh.log");
    writeFileSync(log, "");
    write(dir, { "a.md": "a\nA visit to Acme Widgets.\n" });
    sh(dir, ["add", "a.md"]);
    const env = {
      HOME: home,
      PATH: `${stubDir}:${process.env.PATH}`,
      GH_STUB: opts.gh,
      GH_STUB_FILE: remote,
      GH_STUB_LOG: log,
      CI: "",
      SCAFFOLDING_CONFIDENTIAL_TERMS: "",
    };
    const check = (extra: Record<string, string> = {}) =>
      run(dir, "check-confidential", ["--staged"], { ...env, ...extra });
    const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    return { dir, home, check, calls, cache };
  }

  test("fresh machine with access: fetches, caches and finds the term", () => {
    const m = machine({ gh: "ok" });
    const r = m.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("(Acme Widgets)");
    expect(m.calls()).toBe(1);
    expect(readFileSync(m.cache, "utf8")).toBe(fresh);
    // Bun's own transpiler cache may land in HOME; the command writes nothing there.
    expect(readdirSync(m.home)).not.toContain(".config");
    expect(readdirSync(m.home)).not.toContain(".cache");
  });

  test("a copy fetched within the day is used without a fetch", () => {
    const m = machine({ gh: "deny", cache: fresh, cacheDays: 0.5 });
    expect(m.check().out).toContain("(Acme Widgets)");
    expect(m.calls()).toBe(0);
  });

  test("a stale copy within 7 days is used with a warning, retried at most hourly", () => {
    const m = machine({ gh: "deny", cache: builtDaysAgo(2), cacheDays: 2 });
    const first = m.check();
    expect(first.out).toContain("using the copy fetched before");
    expect(first.out).toContain("(Acme Widgets)");
    expect(first.out).not.toContain("Refused");
    expect(m.calls()).toBe(1);
    expect(m.check().out).toContain("next fetch within the hour");
    expect(m.calls()).toBe(1);
  });

  test("a stale copy is replaced when the fetch works", () => {
    const m = machine({ gh: "ok", cache: builtDaysAgo(2), cacheDays: 2 });
    m.check();
    expect(m.calls()).toBe(1);
    expect(readFileSync(m.cache, "utf8")).toBe(fresh);
  });

  test("a list built more than 7 days ago refuses, even freshly fetched", () => {
    const m = machine({ gh: "ok", remote: builtDaysAgo(10) });
    const r = m.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("list built 10 days ago, more than 7");
    expect(r.out).toContain("gh auth login");
  });

  test("no access and no copy refuses the commit, even for text without a term", () => {
    const m = machine({ gh: "deny" });
    write(m.dir, { "a.md": "a\nnothing confidential\n" });
    sh(m.dir, ["add", "a.md"]);
    const r = m.check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("HTTP 404");
    expect(r.out).toContain("Refused");
  });

  test("CI skips the term step without fetching, the path rule still holds", () => {
    const m = machine({ gh: "deny" });
    expect(m.check({ CI: "true" }).code).toBe(0);
    expect(m.calls()).toBe(0);
    write(m.dir, { "docs/agent-work/shot.png": "x" });
    sh(m.dir, ["add", "docs/agent-work/shot.png"]);
    expect(m.check({ CI: "true" }).out).toContain("image or PDF in docs/agent-work not read");
  });

  test("a PDF that cannot be read is refused", () => {
    const m = machine({ gh: "ok" });
    write(m.dir, { "a.md": "a\n", "talk.pdf": "%PDF-1.4" });
    sh(m.dir, ["add", "a.md", "talk.pdf"]);
    const r = m.check({ PATH: `${stubDir}:/usr/bin:/bin` });
    expect(r.out).toContain("talk.pdf: PDF not read");
    expect(r.code).toBe(1);
  });
});

describe("scaffolding check", () => {
  const gate = (scaffolding: object, scripts: Record<string, string> = {}) =>
    repo({ "package.json": JSON.stringify({ name: "fx", type: "module", scripts, scaffolding }) });
  // Every shared step skipped, so only the runner's own logic is under test.
  const all = {
    format: "t",
    lint: "t",
    styles: "t",
    typecheck: "t",
    structure: "t",
    coupling: "t",
  };
  const skip = {
    ...all,
    "unique-names": "t",
    confidential: "t",
    licenses: "t",
    test: "t",
    catalog: "t",
    admin: "t",
  };

  test("runs the repository's steps in order and passes", () => {
    const dir = gate({ skip, check: ["mine", ["true", "true"]] }, { mine: "echo ran-mine" });
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(0);
    expect(r.out).toContain("ran-mine");
    expect(r.out).toContain("passed");
  });

  test("uniqueNames exempt the names they list, $ included", () => {
    const { "unique-names": _, ...rest } = skip;
    const dir = gate({ skip: rest, uniqueNames: ["$state"] });
    write(dir, {
      "a.ts": "export function $state() {}\n",
      "b.ts": "export function $state() {}\n",
    });
    sh(dir, ["add", "a.ts", "b.ts"]);
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.out).toContain("ok   unique-names");
    expect(r.code).toBe(0);
  });

  test("a failing step fails the gate and stops the later ones", () => {
    const dir = gate({ skip, check: ["false", "echo never-ran"] });
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL false");
    expect(r.out).not.toContain("never-ran");
  });

  test("a gate without tests goes red unless the skip gives a reason", () => {
    const { test: _, ...noTest } = skip;
    const dir = gate({ skip: noTest });
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(1);
    expect(r.out).toContain("scaffolding.test is missing");
    const named = gate({ skip: noTest, test: "echo ran-tests" });
    const ok = run(named, "scaffolding", ["check"], { CHECK_LOCK: join(named, ".lock") });
    expect(ok.out).toContain("ran-tests");
    expect(ok.code).toBe(0);
  });

  test("the catalog build is a shared step: bun run build", () => {
    const { catalog: _, ...noCatalog } = skip;
    const built = gate({ skip: noCatalog }, { build: "echo ran-build" });
    const ok = run(built, "scaffolding", ["check"], { CHECK_LOCK: join(built, ".lock") });
    expect(ok.out).toContain("ok   catalog");
    expect(ok.out).toContain("ran-build");
    expect(ok.code).toBe(0);
    const broken = gate({ skip: noCatalog }, { build: "exit 3" });
    const r = run(broken, "scaffolding", ["check"], { CHECK_LOCK: join(broken, ".lock") });
    expect(r.out).toContain("FAIL catalog");
    expect(r.code).toBe(1);
  });

  test("the styles step prints one line per finding and fails", () => {
    const { styles: _, ...noStyles } = skip;
    const dir = repo({
      "package.json": JSON.stringify({
        name: "fx",
        type: "module",
        scaffolding: { skip: noStyles },
      }),
      "node_modules/@hackersandwizards/brand/package.json": JSON.stringify({
        exports: { "./tokens.root.css": "./tokens.root.css" },
      }),
      "node_modules/@hackersandwizards/brand/tokens.root.css": ":root { --color-ink: #000; }\n",
      "stylelint.config.js": `import styles from "${join(import.meta.dir, "..", "config", "stylelint.js")}";\nexport default { ...styles(), ignoreFiles: ["nested/**"] };\n`,
      "src/bad.css": "a { color: var(--color-nope); }\n",
      "nested/.stylelintrc.json": "{}",
      "nested/Odd.astro": "---\nconst x = 1;\n---\n<p>{x}</p>\n",
      "src/Bad.astro":
        '---\nconst x = "";\n---\n<style set:html={x} />\n<p>a</p>\n<style>\n  p { color: var(--color-astro); }\n</style>\n',
    });
    mkdirSync(join(dir, "node_modules/.bin"));
    symlinkSync(
      join(import.meta.dir, "..", "node_modules/stylelint/bin/stylelint.mjs"),
      join(dir, "node_modules/.bin/stylelint"),
    );
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.out).toContain(
      'src/bad.css: line 1, col 16, error - Unexpected custom property "--color-nope"',
    );
    expect(r.out).toContain(
      'src/Bad.astro: line 7, col 18, error - Unexpected custom property "--color-astro"',
    );
    expect(r.out).not.toContain("nested/Odd.astro");
    expect(r.out).toContain("FAIL styles");
    expect(r.code).toBe(1);
  });

  test("the admin step runs the pinned admin-check; without admin pinned it needs skip.admin", () => {
    const { admin: _, ...noAdmin } = skip;
    const bare = gate({ skip: noAdmin });
    const unpinned = run(bare, "scaffolding", ["check"], { CHECK_LOCK: join(bare, ".lock") });
    expect(unpinned.code).toBe(1);
    expect(unpinned.out).toContain(
      "@hackersandwizards/admin is not pinned: pin it, or skip.admin with a reason",
    );
    const pinned = (verdict: string) => {
      const dir = repo({
        "package.json": JSON.stringify({
          name: "fx",
          type: "module",
          devDependencies: { "@hackersandwizards/admin": "file:./admin" },
          scaffolding: { skip: noAdmin },
        }),
        "admin/package.json": JSON.stringify({
          name: "@hackersandwizards/admin",
          bin: { "admin-check": "check.sh" },
        }),
        "admin/check.sh": `#!/bin/sh\necho admin-check-ran\n${verdict}\n`,
      });
      spawnSync("chmod", ["+x", join(dir, "admin/check.sh")]);
      return run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    };
    const red = pinned("exit 1");
    expect(red.out).toContain("admin-check-ran");
    expect(red.out).toContain("FAIL admin");
    expect(red.code).toBe(1);
    const green = pinned("exit 0");
    expect(green.out).toContain("ok   admin");
    expect(green.code).toBe(0);
  });

  test("an unknown key, an unknown skip and a skip without reason go red", () => {
    for (const config of [
      { skip, chek: [] },
      { skip: { ...skip, lnt: "t" } },
      { skip: { ...skip, lint: " " } },
    ]) {
      const dir = gate(config);
      expect(run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") }).code).toBe(1);
    }
  });
});

describe("shared eslint config", () => {
  test("an empty test body goes red, a real one stays green", () => {
    const dir = repo({
      "eslint.config.js": `import base from "${join(import.meta.dir, "..", "config", "eslint.js")}";\nexport default base;\n`,
      "a.test.ts": 'test("x", () => {});\n',
      "b.test.ts": 'test("x", () => { expect(1).toBe(1); });\n',
    });
    const eslint = join(import.meta.dir, "..", "node_modules", ".bin", "eslint");
    const r = spawnSync(eslint, ["a.test.ts", "b.test.ts"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("a.test.ts");
    expect(r.stdout).not.toContain("b.test.ts");
  });
});

describe("catalog", () => {
  test("catalogPath: the root, or /catalog/ beside the site's own home; dev drops the base", () => {
    expect(catalogPath({ base: "/s", pages: ["types", "about.astro"] })).toBe("/s/");
    for (const page of ["index.astro", "index.html.ts", "index", "[...slug].astro"])
      expect(catalogPath({ base: "/s/", pages: [page] })).toBe("/s/catalog/");
    expect(catalogPath({ base: "/s", pages: ["[slug].astro", "indexes"], dev: true })).toBe("/");
    expect(catalogPath({ base: "/s", pages: ["index.astro"], dev: true })).toBe("/catalog/");
  });

  test("the preset builds the shell's home into the repository's dist/", () => {
    const fixture = join(import.meta.dir, "fixture");
    const dist = join(fixture, "dist");
    made.push(dist, join(fixture, "catalog", ".astro"), join(fixture, "catalog", "node_modules"));
    const astro = join(import.meta.dir, "..", "node_modules", ".bin", "astro");
    const build = (args: string[] = [], env: Record<string, string> = {}) =>
      spawnSync(astro, ["build", "--root", "catalog", ...args], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, CI: "", ...env },
      });
    const r = build();
    expect(r.status).toBe(0);
    // No page of its own at pages/index: the catalog is the site's home.
    const home = readFileSync(join(dist, "index.html"), "utf8");
    expect(home).toContain('<header class="fx-header"><a href="/">Fx</a></header>');
    expect(home).toContain("fx catalog/stories · 3 components · 24 states");
    // The admin hub serves only on this machine: a built page carries no link to it.
    expect(home).not.toContain("admin.localhost");
    expect(home.indexOf(">Types <")).toBeLessThan(home.indexOf(">Parts <"));
    // The rail names every element under its group, linked to the state its tile draws.
    expect(home).toMatch(
      /<ul class="hw-catalogue-names"><li><a href="\/dashboard\/Parts\/box-parts\/two">BoxParts<\/a>/,
    );
    expect(home).toContain('src="/stories/Types/box-types/two"');
    expect(readdirSync(join(dist, "stories/Parts/box-parts"))).toEqual(["one", "two"]);
    // `previewSize` per group: a Types tile draws its frame whole at 1440 x 900, a Parts tile at
    // three quarters.
    expect(home).toContain(
      'data-frame-width="1440" style="aspect-ratio:1440/900"><iframe src="/stories/Types/box-types/two"',
    );
    expect(home).toMatch(/<span class="hw-catalogue-preview"><iframe src="\/stories\/Parts\//);
    // The shell's own card and pill carry data-hw-shell, for brand-elements to skip.
    expect(home).toContain('<a class="hw-card hw-catalogue-tile" data-hw-shell href=');
    expect(home).toContain('<span class="hw-pill" data-tone="neutral" data-hw-shell>');
    expect(readFileSync(join(dist, "fx.txt"), "utf8")).toBe("fx\n");
    const page = (p: string) => readFileSync(join(dist, p, "index.html"), "utf8");
    // Every page says noindex; the shell draws dense, a story at `storyScale`, and every page but a
    // state alone turns with the theme toggle.
    const root = (html: string) =>
      html.match(/Object\.assign\(document\.documentElement\.dataset,(\{.*?\})\);/)?.[1];
    expect(root(home)).toBe('{"hwScale":"dense","hwNight":""}');
    expect(root(page("dashboard/Parts/box-parts/two"))).toBe('{"hwScale":"screen","hwNight":""}');
    expect(root(page("stories/Parts/box-parts/two"))).toBe('{"hwScale":"screen"}');
    for (const p of ["", "dashboard/Parts/box-parts/two", "stories/Parts/box-parts/two", "catalog"])
      expect(page(p)).toContain('<meta name="robots" content="noindex">');
    // Every page of the catalog's former place forwards to its page at the root.
    expect(page("catalog/dashboard/Parts/box-parts/two")).toContain(
      'http-equiv="refresh" content="0; url=/dashboard/Parts/box-parts/two/"',
    );
    expect(page("catalog")).toContain('content="0; url=/"');
    const state = page("dashboard/Parts/box-parts/two");
    const css = readdirSync(join(dist, "_astro"))
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(dist, "_astro", f), "utf8"))
      .join("");
    expect(state).toContain('<meta name="fx-head" content="repository">');
    expect(`${state}${css}`).toMatch(
      /#astrobook-sidebar,\s*astrobook-sidebar-resize-handle\s*\{\s*display:\s*none\s*!important/,
    );
    const barOf = (html: string) =>
      html.match(/<template id="hw-catalogue-bar">([\s\S]*?)<\/template>/)?.[1] ?? "";
    const bar = barOf(state);
    expect(bar).toContain('<nav class="hw-catalogue-bar" aria-label="Catalog">');
    expect(bar).toContain('<a href="/"><span aria-hidden="true">');
    expect(bar).toMatch(/Parts \/ <strong>BoxParts<\/strong>/);
    expect(bar).toContain('<button type="button" data-hw-theme aria-pressed="false">');
    expect(bar).toContain('href="/stories/Parts/box-parts/two">Open this state alone</a>');
    expect(bar).toContain('<ul aria-label="States">');
    expect(bar).toMatch(/href="\/dashboard\/Parts\/box-parts\/one">One/);
    expect(bar).toMatch(/href="\/dashboard\/Parts\/box-parts\/two" aria-current="page">Two/);
    expect(bar).toContain('<a rel="prev" href="/dashboard/Parts/box-parts/one"');
    expect(bar).toContain('<a rel="next" aria-disabled="true"');
    expect(bar).toContain("2 of 2");
    // Above 12 states a menu replaces the chips, grouped by a word three names share.
    const many = barOf(page("dashboard/Parts/many-parts/block-image"));
    expect(many).not.toContain("<ul");
    expect(many).toContain(
      '<optgroup label="Block"><option value="/dashboard/Parts/many-parts/block-code">Block code</option><option value="/dashboard/Parts/many-parts/block-image" selected>Block image</option>',
    );
    expect(many).toContain(
      '<optgroup label="Theme"><option value="/dashboard/Parts/many-parts/accent-theme">Accent theme</option>',
    );
    expect(many).toContain(
      '</optgroup><option value="/dashboard/Parts/many-parts/angebot-ohne-preise">Angebot ohne Preise</option>',
    );
    // A camelCase state reads in sentence case, an acronym kept; a name with underscores keeps its
    // author's case. Either way the first word is capitalised.
    expect(many).toMatch(/many-parts\/density-on-pdf">Density on PDF</);
    expect(many).toMatch(/">Folie 35 Eine Woche zum</);
    expect(many).toMatch(/">In German</);
    // So a German noun after the first word needs an underscore name.
    expect(many).toMatch(/">Mit impressum</);
    expect(many).toMatch(/">Primary on night</);
    // A plural acronym and a listed name with inner capitals stay whole.
    expect(many).toMatch(/many-parts\/two-pd-fs">Two PDFs</);
    expect(many).toMatch(/many-parts\/loading-git-hub">Loading GitHub</);
    expect(state).toContain("main.prepend(bar.content.cloneNode(true))");
    expect(page("stories/Parts/box-parts/two")).not.toContain('id="hw-catalogue-bar"');
    expect(home).not.toContain('id="hw-catalogue-bar"');
    // `serverOnly`: no state's route keeps Astrobook's client:load branch.
    const codegen = join(
      fixture,
      "catalog/.astro/integrations/_hackersandwizards_scaffolding_catalog",
    );
    const routes = readdirSync(codegen, { recursive: true, encoding: "utf8" }).filter((f) =>
      f.endsWith(".astro"),
    );
    expect(routes.length).toBe(48);
    for (const f of routes)
      expect(readFileSync(join(codegen, f), "utf8")).not.toContain("client:load");
    // `copy`: each match at its own path, the rest of the folder left out.
    expect(readdirSync(join(dist, "assets")).sort()).toEqual(["logo.svg", "nested"]);
    expect(readFileSync(join(dist, "assets/nested/page.css"), "utf8")).toBe(
      "a {\n  color: red;\n}\n",
    );
    // A package path lands at that path, resolved through the package's exports.
    expect(readFileSync(join(dist, "@acme/fx/logos/logo.svg"), "utf8")).toBe(
      readFileSync(join(fixture, "assets/logo.svg"), "utf8"),
    );
    // A project Pages site sets Astro's base: the links and the header's default follow it.
    expect(build(["--base", "/fx"]).status).toBe(0);
    const based = readFileSync(join(dist, "index.html"), "utf8");
    expect(based).toContain('<header class="fx-header"><a href="/fx/">Fx</a></header>');
    expect(based).toContain('src="/fx/stories/Types/box-types/two"');
    expect(page("catalog/stories/Types/box-types/two")).toContain(
      'url=/fx/stories/Types/box-types/two/"',
    );
    // A base ending in /catalog mounts the catalog under a host with its own home: no forwarding
    // pages and no public/, which the host serves.
    expect(build(["--base", "/catalog"]).status).toBe(0);
    expect(readFileSync(join(dist, "index.html"), "utf8")).toContain(
      'src="/catalog/stories/Types/box-types/two"',
    );
    expect(existsSync(join(dist, "catalog"))).toBe(false);
    expect(existsSync(join(dist, "fx.txt"))).toBe(false);
    // An outDir the config sets stays; only Astro's default moves to the repository's dist/.
    const custom = join(fixture, "catalog", "custom");
    made.push(custom);
    expect(build(["--outDir", "./custom"]).status).toBe(0);
    expect(existsSync(join(custom, "index.html"))).toBe(true);
    // A redirect from "/" would take the catalog's place: the build fails and says why.
    const redirecting = join(fixture, "catalog", "redirecting.config.mjs");
    made.push(redirecting);
    writeFileSync(
      redirecting,
      'import config from "./astro.config.mjs";\nexport default { ...config, redirects: { "/": "/x/" } };\n',
    );
    const refused = build(["--config", "redirecting.config.mjs"]);
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain("`redirects` leaves out");
    rmSync(redirecting);
    // A package path outside the package's exports fails the build by name.
    const unexported = join(fixture, "catalog", "unexported.config.mjs");
    made.push(unexported);
    writeFileSync(
      unexported,
      'import config from "./astro.config.mjs";\nimport { catalog } from "../../../catalog/index.ts";\nexport default { ...config, integrations: [catalog({ product: "Fx", css: [], lead: "", copy: ["@acme/fx/assets/skip.txt"] })] };\n',
    );
    const missing = build(["--config", "unexported.config.mjs"]);
    expect(`${missing.stdout}${missing.stderr}`).toContain(
      "catalog copy: @acme/fx/assets/skip.txt is no file in the exports of @acme/fx",
    );
    rmSync(unexported);
    // A site with a home page of its own keeps the catalog at /catalog/.
    const src = join(fixture, "catalog", "src");
    const pages = join(src, "pages");
    made.push(src);
    mkdirSync(pages, { recursive: true });
    writeFileSync(join(pages, "index.astro"), "<p>site home</p>\n");
    expect(build().status).toBe(0);
    expect(page("").includes("site home")).toBe(true);
    expect(page("catalog")).toContain("fx catalog/stories");
    expect(page("catalog/dashboard/Parts/box-parts/two")).toContain('href="/catalog/"');
    rmSync(src, { recursive: true });
    // In CI a copied file still a Git LFS pointer fails the build; locally it passes.
    const ci = build([], { CI: "true" });
    expect(ci.status).not.toBe(0);
    expect(`${ci.stdout}${ci.stderr}`).toContain(
      "catalog copy: still Git LFS pointers: assets/nested/lfs.woff2",
    );
  }, 60_000);

  // A repository's head sets attributes on <html> and runs page scripts: Astrobook's client router
  // swapped pages in place, which dropped both until a reload.
  test("dev serves `copy`, and a click in the bar loads the next state in full", async () => {
    const { serve, freePort } = await import("../lib/serve.ts");
    const { chromeArgs, chromeBinary, INSTALL_HINT } = await import("../lib/chrome.ts");
    const fixture = join(import.meta.dir, "fixture");
    made.push(join(fixture, "catalog", ".astro"), join(fixture, "catalog", "node_modules"));
    // Modules at paths a forward would take, as a site whose Astro root holds catalog/ serves its
    // catalog/Head.astro and catalog/stories/ under the base /catalog.
    for (const dir of ["fx", "catalog/stories"]) {
      mkdirSync(join(fixture, "catalog", dir), { recursive: true });
      writeFileSync(join(fixture, "catalog", dir, "mod.css"), "a {\n  color: red;\n}\n");
    }
    made.push(join(fixture, "catalog", "fx"), join(fixture, "catalog", "catalog"));
    const astro = join(import.meta.dir, "..", "node_modules", ".bin", "astro");
    // ASTRO_DEV_BACKGROUND=1, as the README's dev script: under an agent astro dev otherwise moves
    // into the background and resolves --root from inside the folder.
    const server = await serve(
      [
        "sh",
        "-c",
        `cd '${fixture}' && exec '${astro}' dev --root catalog --base /fx --host $HOST --port $PORT`,
      ],
      { env: { ASTRO_DEV_BACKGROUND: "1" }, timeoutMs: 30_000 },
    );
    const chrome = chromeBinary();
    if (!chrome) throw new Error(INSTALL_HINT);
    const port = await freePort();
    const browser = Bun.spawn([chrome, ...chromeArgs(temp()), `--remote-debugging-port=${port}`], {
      stderr: "ignore",
    });
    try {
      const logo = await fetch(`${server.url}/assets/logo.svg`);
      expect(logo.status).toBe(200);
      const served = await fetch(`${server.url}/@acme/fx/logos/logo.svg`);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/svg+xml");
      expect(logo.headers.get("content-type")).toBe("image/svg+xml");
      const css = await fetch(`${server.url}/assets/nested/page.css`);
      expect(css.headers.get("content-type")).toBe("text/css");
      expect(await css.text()).toBe("a {\n  color: red;\n}\n");
      expect((await fetch(`${server.url}/assets/skip.txt`)).status).toBe(404);
      // `admin`: in dev the header links the repository's page in the local hub; the fixture's
      // repository is this checkout.
      expect(await (await fetch(`${server.url}/`)).text()).toMatch(
        /<a class="hw-header-link" href="http:\/\/admin\.localhost:4329\/scaffolding\/dashboard"[^>]*><span aria-hidden="true"[^>]*>←&nbsp;<\/span>Admin hub<\/a>/,
      );

      // Dev serves at the root: the old /catalog/ path and the Pages base forward there.
      for (const [old, to] of [
        ["/catalog/dashboard/Parts/box-parts/two?x", "/dashboard/Parts/box-parts/two?x"],
        ["/fx/catalog/", "/"],
        ["/catalog/stories/%E2%82%AC", "/stories/%E2%82%AC"],
        ["/fx//evil.example/x", "/evil.example/x"],
      ]) {
        const r = await fetch(`${server.url}${old}`, { redirect: "manual" });
        expect([r.status, r.headers.get("location")]).toEqual([307, to]);
      }
      // A file under the root is a module, not a page: it stays where it is.
      for (const path of ["/fx/mod.css", "/catalog/stories/mod.css"])
        expect((await fetch(`${server.url}${path}`, { redirect: "manual" })).status).toBe(200);
      // A page of the site's own under /catalog/ is not one of the catalog's former pages.
      expect((await fetch(`${server.url}/catalog/print/`, { redirect: "manual" })).status).not.toBe(
        307,
      );
      const start = `${server.url}/dashboard/Parts/box-parts/two`;
      let target: { webSocketDebuggerUrl: string } | undefined;
      for (let i = 0; i < 100 && !target; i++)
        target = await fetch(`http://127.0.0.1:${port}/json/new?${start}`, { method: "PUT" })
          .then((r) => r.json())
          .catch(() => new Promise((r) => setTimeout(r, 100)));
      const ws = new WebSocket(target!.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));
      let id = 0;
      const evaluate = (expression: string) =>
        new Promise<unknown>((done) => {
          const call = ++id;
          const on = (event: MessageEvent) => {
            const message = JSON.parse(String(event.data));
            if (message.id !== call) return;
            ws.removeEventListener("message", on);
            done(message.result?.result?.value);
          };
          ws.addEventListener("message", on);
          ws.send(JSON.stringify({ id: call, method: "Runtime.evaluate", params: { expression } }));
        });
      const until = async (expression: string) => {
        for (const end = Date.now() + 20_000; Date.now() < end;) {
          if (await evaluate(expression)) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`timed out: ${expression}`);
      };
      await until(`document.readyState === "complete" && !!document.body.dataset.fxRan`);
      await evaluate(
        `document.querySelector('.hw-catalogue-bar a[href$="/box-parts/one"]').click()`,
      );
      await until(`location.pathname.endsWith("/one") && document.readyState === "complete"`);
      await new Promise((r) => setTimeout(r, 500));
      const after = await evaluate(
        `JSON.stringify([document.documentElement.dataset.fxHead, document.documentElement.dataset.hwScale, document.body.dataset.fxRan, !!document.querySelector("main .hw-catalogue-bar")])`,
      );
      expect(JSON.parse(String(after))).toEqual([
        "repository",
        "screen",
        "/dashboard/Parts/box-parts/one",
        true,
      ]);
      // The right arrow key steps to the next state.
      await evaluate(
        `document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))`,
      );
      await until(`location.pathname.endsWith("/two") && document.readyState === "complete"`);
      ws.close();
    } finally {
      browser.kill();
      server.stop();
    }
  }, 90_000);

  test("group anchors keep non-ASCII letters", async () => {
    const { renderCatalog } = await import("../catalog/render.ts");
    const item = { name: "x", href: "/x" };
    const html = renderCatalog({
      title: "t",
      lead: "l",
      provenance: "p",
      groups: [
        { name: "Übersicht", items: [item] },
        { name: "bersicht", items: [item] },
        { name: "A\u0308nderung", items: [item] },
      ],
    });
    expect(html).toContain('id="änderung"');
    expect(html).toContain('id="übersicht"');
    expect(html).toContain('id="bersicht"');
  });
});

describe("shared prettier config", () => {
  test("an .astro file is formatted, its plugin found from the package, not the repository", () => {
    const config = join(import.meta.dir, "..", "config", "prettier.js");
    const dir = temp();
    write(dir, {
      "package.json": JSON.stringify({ prettier: config }),
      "A.astro": '---\nconst a=1\n---\n<div   class="x">{a}</div>\n',
    });
    const prettier = join(import.meta.dir, "..", "node_modules", ".bin", "prettier");
    const r = spawnSync(prettier, ["--check", "--ignore-unknown", "A.astro"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(`${r.stdout}${r.stderr}`).toContain("[warn] A.astro");
    expect(r.status).toBe(1);
  });
});

describe("shared stylelint config", () => {
  test("a custom property brand and the repository do not define goes red", () => {
    const config = join(import.meta.dir, "..", "config", "stylelint.js");
    const dir = repo({
      "package.json": JSON.stringify({ name: "fx", type: "module" }),
      "node_modules/@hackersandwizards/brand/package.json": JSON.stringify({
        exports: { "./tokens.root.css": "./generated/tokens.root.css" },
      }),
      "node_modules/@hackersandwizards/brand/generated/tokens.root.css":
        ":root { --color-ink: #000; }\n",
      "src/own.css": ":root { --own-gap: 1rem; }\n",
      "stylelint.config.js": `import styles from "${config}";\nexport default styles({ importFrom: ["./src/own.css"] });\n`,
      "src/ok.css": "a { color: var(--color-ink); margin: var(--own-gap); }\n",
      "src/bad.css": "a { color: var(--color-nope); }\n",
    });
    const stylelint = join(import.meta.dir, "..", "node_modules", ".bin", "stylelint");
    const r = spawnSync(stylelint, ["src/*.css"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(2);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain("src/bad.css");
    expect(out).toContain("--color-nope");
    expect(out).not.toContain("src/ok.css");
    rmSync(join(dir, "node_modules/@hackersandwizards/brand"), { recursive: true });
    const gone = spawnSync(stylelint, ["src/ok.css"], { cwd: dir, encoding: "utf8" });
    expect(gone.status).not.toBe(0);
  });
});

describe("check-staged", () => {
  // A stand-in for admin's bin: red while any item file says "broken".
  const adminCheck = '#!/bin/sh\n! grep -rl broken "${1:-.}/docs/agent-work/items"\n';
  const pkg = JSON.stringify({
    scaffolding: { private: true },
    devDependencies: { "@hackersandwizards/admin": "github:acme/admin#v1.0.0" },
  });

  test("a staged item file runs admin-check, a broken one goes red", () => {
    const dir = repo({ "package.json": pkg, "docs/agent-work/items/a.md": "fine\n" });
    write(dir, { "node_modules/.bin/admin-check": adminCheck });
    spawnSync("chmod", ["+x", join(dir, "node_modules/.bin/admin-check")]);
    write(dir, { "docs/agent-work/items/a.md": "broken\n" });
    sh(dir, ["add", "docs/agent-work/items/a.md"]);
    expect(run(dir, "check-staged").code).toBe(1);
    write(dir, { "docs/agent-work/items/a.md": "fine again\n" });
    expect(run(dir, "check-staged").code).toBe(1);
    sh(dir, ["add", "docs/agent-work/items/a.md"]);
    expect(run(dir, "check-staged").code).toBe(0);
    write(dir, { "docs/agent-work/items/a.md": "broken, unstaged\n" });
    expect(run(dir, "check-staged").code).toBe(0);
  });

  test("a staged item file without admin-check installed is refused", () => {
    const dir = repo({ "package.json": pkg, "docs/agent-work/items/a.md": "fine\n" });
    write(dir, { "docs/agent-work/items/a.md": "changed\n" });
    sh(dir, ["add", "docs/agent-work/items/a.md"]);
    const r = run(dir, "check-staged");
    expect(r.code).toBe(1);
    expect(r.out).toContain("admin-check not installed");
  });

  test("a tool that exits before reading a partly staged file fails the check, never crashes it", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        scaffolding: { private: true },
        devDependencies: { prettier: "3" },
      }),
      "big.txt": "a\n",
      "node_modules/.bin/prettier": "#!/bin/sh\nexit 0\n",
    });
    spawnSync("chmod", ["+x", join(dir, "node_modules/.bin/prettier")]);
    // Larger than the pipe holds, so the write outlives the tool and raises EPIPE.
    write(dir, { "big.txt": "staged line\n".repeat(200_000) });
    sh(dir, ["add", "big.txt"]);
    write(dir, { "big.txt": "unstaged\n" });
    const r = run(dir, "check-staged");
    expect(r.out).not.toContain("EPIPE");
    expect(r.out).toContain("[check:staged] prettier: big.txt as staged");
    expect(r.code).toBe(1);
  });

  test("a file staged in the old docs/tracking folder runs admin-check too", () => {
    const dir = repo({ "package.json": pkg });
    write(dir, { "docs/tracking/items/a.md": "fine\n" });
    sh(dir, ["add", "docs/tracking/items/a.md"]);
    expect(run(dir, "check-staged").out).toContain("admin-check not installed");
  });
});

describe("check-unique-names", () => {
  const code = {
    "src/a.ts": "export function twice() {}\n",
    "copy/b.ts": "export function twice() {}\n",
  };
  const withAllow = (path: string) =>
    repo({
      ...code,
      "package.json": JSON.stringify({
        scaffolding: { allow: [{ check: "unique-names", path, reason: "synced copy" }] },
      }),
    });

  test("a name defined twice is red unless an allow entry covers one site; a stale entry is red", () => {
    const red = run(repo({ ...code, "package.json": "{}" }), "check-unique-names");
    expect(red.code).toBe(1);
    expect(red.out).toContain("twice is defined 2 times");
    expect(run(withAllow("copy/*"), "check-unique-names").code).toBe(0);
    const stale = run(withAllow("elsewhere/*"), "check-unique-names");
    expect(stale.code).toBe(1);
    expect(stale.out).toContain("allow entry matches nothing");
  });

  test("a file with a non-ASCII name is read", () => {
    const dir = repo({
      "src/a.ts": code["src/a.ts"],
      "src/ü.ts": code["src/a.ts"],
      "package.json": "{}",
    });
    const r = run(dir, "check-unique-names");
    expect(r.out).toContain("src/ü.ts:1");
    expect(r.code).toBe(1);
  });
});

describe("check-spaces", () => {
  const page = [
    "---",
    "const a = 1",
    "<code>in frontmatter</code>",
    "---",
    "<p>",
    "  drawn by",
    "  <code>brand</code>'s <code>elements.css</code> at the dense scale.",
    "  <code>x</code> in",
    "  <strong>check</strong>",
    "  holds each, and",
    '  <a href="/x">a link</a>.',
    '  Wanted{" "}',
    "  <em>space</em>",
    "  {list.map((i) => (",
    "    <span>{i}</span>",
    "  ))}",
    "  {cond && (",
    "    <span>y</span>",
    "  )}",
    "  <!-- a comment",
    "  <kbd>k</kbd> -->",
    "  (",
    "  <code>z</code>",
    "</p>",
    "<script>",
    "  const s = 1",
    "  <span>",
    "</script>",
    '<script type="application/ld+json" set:html={JSON.stringify(x => y)} />',
    "<p>",
    "  then",
    "  <a",
    '    href="/x">x</a>',
    "</p>",
    "<pre-view>",
    "  drawn by",
    "  <code>x</code>",
    "</pre-view>",
    "<pre>",
    "run the",
    "<code>check</code>",
    "</pre>",
    "",
  ].join("\n");

  test("finds text meeting an inline tag across a line break, and nothing else", () => {
    const r = run(repo({ "src/A.astro": page, "package.json": "{}" }), "check-spaces");
    expect(r.code).toBe(1);
    expect(
      lines(r.out, "spaces").map((l) => l.match(/line (\d+):.*?meets <(\w+)>/)!.slice(1)),
    ).toEqual([
      ["6", "code"],
      ["7", "code"],
      ["8", "strong"],
      ["9", "strong"],
      ["10", "a"],
      ["31", "a"],
      ["36", "code"],
    ]);
    const empty = run(
      repo({ "src/B.astro": "---\n---\n<code>x</code>\n", "package.json": "{}" }),
      "check-spaces",
    );
    expect(empty.code).toBe(0);
  });

  test("an allow entry keeps a flex case; a stale one is red", () => {
    const allowed = (text: string) =>
      repo({
        "src/A.astro": "<h2>\n  <span></span>\n  Running\n</h2>\n",
        "package.json": JSON.stringify({
          scaffolding: { allow: [{ check: "spaces", path: "src/*.astro", text, reason: "flex" }] },
        }),
      });
    expect(run(allowed("<span></span>"), "check-spaces").code).toBe(0);
    expect(run(allowed("nothing"), "check-spaces").out).toContain("allow entry matches nothing");
  });
});

describe("check-licenses", () => {
  function installed(licences: Record<string, unknown>, scaffolding: object = {}) {
    const files: Record<string, string> = {};
    const dependencies: Record<string, string> = {};
    for (const [name, licence] of Object.entries(licences)) {
      const folder = name.replace("/", "+");
      files[`pkgs/${folder}/package.json`] = JSON.stringify({
        name,
        version: "1.0.0",
        ...(licence === undefined ? {} : (licence as object)),
      });
      dependencies[name] = `file:./pkgs/${folder}`;
    }
    const dir = repo({
      ...files,
      "package.json": JSON.stringify({ name: "fx", dependencies, scaffolding }),
    });
    const install = spawnSync(process.execPath, ["install"], { cwd: dir, encoding: "utf8" });
    expect(install.status).toBe(0);
    return dir;
  }
  const license = (l: string) => ({ license: l });

  test("the report's edge cases: copyleft and unknown red, permissive and OR green, own skipped", () => {
    const dir = installed({
      "gpl-3-only": license("GPL-3.0-only"),
      "agpl-3": license("AGPL-3.0"),
      "@scope/agpl-later": license("AGPL-3.0-or-later"),
      "gpl-2-plus": license("GPL-2.0+"),
      "bare-lgpl": license("LGPL"),
      "and-lgpl": license("Apache-2.0 AND LGPL-3.0-or-later"),
      "gpl-with": license("GPL-2.0-only WITH Classpath-exception-2.0"),
      "or-gpl": license("(MIT OR GPL-3.0-or-later)"),
      "array-mit-gpl": { licenses: [{ type: "MIT" }, { type: "GPL-2.0" }] },
      "mpl-2": license("MPL-2.0"),
      "nested-or": license("(MIT AND (LGPL-2.1-or-later OR BSD-3-Clause))"),
      "no-field": undefined,
      "see-license": license("SEE LICENSE IN LICENSE"),
      "vendor-url": license("https://example.com/terms"),
      "@hackersandwizards/own": license("SEE LICENSE IN LICENSE"),
      "@img/sharp-libvips-darwin-arm64": license("LGPL-3.0-or-later"),
    });
    const r = run(dir, "check-licenses");
    expect(r.code).toBe(1);
    const red = lines(r.out, "check-licenses").map((l) => l.match(/^\S+ @?[^@]+/)?.[0]);
    expect(red.sort()).toEqual(
      [
        "@scope/agpl-later",
        "agpl-3",
        "and-lgpl",
        "bare-lgpl",
        "gpl-2-plus",
        "gpl-3-only",
        "gpl-with",
        "no-field",
        "see-license",
        "vendor-url",
      ].map((n) => `[check-licenses] ${n}`),
    );
    expect(r.out).toContain("bun pm why gpl-3-only");
    expect(r.out).toContain('"gpl-3-only": { "license": "GPL-3.0-only"');
  });

  test("a planted GPL dependency is red, a permissive one green", () => {
    expect(run(installed({ planted: license("GPL-3.0-only") }), "check-licenses").code).toBe(1);
    expect(run(installed({ planted: license("MIT") }), "check-licenses").code).toBe(0);
  });

  test("an exception pins the licence string and needs a reason; a stale one is red", () => {
    const keep = (licenses: object) =>
      run(
        installed({ gsap: license("Standard 'no charge' license") }, { licenses }),
        "check-licenses",
      );
    const pinned = { license: "Standard 'no charge' license", reason: "dev only" };
    expect(keep({ gsap: pinned }).code).toBe(0);
    expect(keep({ "gs*": pinned }).code).toBe(0);
    const changed = keep({ gsap: { ...pinned, license: "MIT" } });
    expect(changed.code).toBe(1);
    expect(changed.out).toContain('pins "MIT", installed is "Standard');
    const reasonless = keep({ gsap: { license: pinned.license } });
    expect(reasonless.code).toBe(1);
    expect(reasonless.out).toContain("needs a license string and a reason");
    const stale = keep({ gsap: pinned, "left-pad": { license: "MIT", reason: "gone" } });
    expect(stale.code).toBe(1);
    expect(stale.out).toContain('scaffolding.licenses["left-pad"] matches no installed package');
  });

  test("fails closed: no node_modules, an empty one, a missing lockfile", () => {
    const dir = installed({ fine: license("MIT") });
    renameSync(join(dir, "node_modules"), join(dir, "node_modules-away"));
    const missing = run(dir, "check-licenses");
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("run bun install");
    mkdirSync(join(dir, "node_modules"));
    const empty = run(dir, "check-licenses");
    expect(empty.code).toBe(1);
    expect(empty.out).toContain("run bun install");
    const bare = repo({ "package.json": JSON.stringify({ name: "fx" }) });
    expect(run(bare, "check-licenses").code).toBe(1);
  });

  test("check-staged runs it when bun.lock or package.json is staged", () => {
    const dir = installed(
      { planted: license("GPL-3.0-only") },
      { private: true, allow: [{ check: "coupling", path: "package.json", reason: "fixture" }] },
    );
    write(dir, { "notes.txt": "x\n" });
    sh(dir, ["add", "notes.txt"]);
    expect(run(dir, "check-staged").out).not.toContain("[check-licenses]");
    write(dir, { "package.json": readFileSync(join(dir, "package.json"), "utf8") + "\n" });
    sh(dir, ["add", "package.json"]);
    const r = run(dir, "check-staged");
    expect(r.code).toBe(1);
    expect(r.out).toContain("[check-licenses] planted");
  });
});

describe("chrome", () => {
  test("CHROME_BINARY wins, else the build puppeteer-core pins, else the newest cached build of this platform, the shell on request", async () => {
    const { cachedChrome, chromeBinary } = await import("../lib/chrome.ts");
    const cache = temp();
    const platform =
      process.platform === "darwin" ? (process.arch === "arm64" ? "mac_arm" : "mac") : "linux";
    const exe =
      process.platform === "darwin"
        ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        : "chrome";
    const plant = (kind: string, build: string, file: string) => {
      const path = join(cache, kind, build, `${kind}-x`, file);
      write("/", { [path]: "" });
      return path;
    };
    const pinned = plant("chrome", `${platform}-9.0.1`, exe);
    const newest = plant("chrome", `${platform}-10.0.1`, exe);
    plant("chrome", `other-99.0.0`, exe);
    const shell = plant("chrome-headless-shell", `${platform}-10.0.1`, "chrome-headless-shell");
    const saved = { ...process.env };
    const cwd = process.cwd();
    process.env.PUPPETEER_CACHE_DIR = cache;
    delete process.env.CHROME_BINARY;
    try {
      expect(cachedChrome()).toBe(newest);
      expect(cachedChrome({ shell: true })).toBe(shell);
      // A consumer's puppeteer-core decides the build, the shell's absent pin finds nothing.
      const consumer = temp();
      write(consumer, {
        "node_modules/puppeteer-core/package.json": JSON.stringify({
          name: "puppeteer-core",
          type: "module",
          exports: { "./internal/*": "./lib/puppeteer/*" },
        }),
        "node_modules/puppeteer-core/lib/puppeteer/revisions.js":
          "export const PUPPETEER_REVISIONS = { chrome: '9.0.1', 'chrome-headless-shell': '8.0.1' };\n",
      });
      process.chdir(consumer);
      expect(cachedChrome()).toBe(pinned);
      expect(cachedChrome({ shell: true })).toBeUndefined();
      process.env.CHROME_BINARY = "/opt/own-chrome";
      expect(chromeBinary()).toBe("/opt/own-chrome");
    } finally {
      process.chdir(cwd);
      process.env = saved;
    }
  });

  test("on an empty cache, concurrent calls share one install, a found path is kept, a failed install runs again", async () => {
    const { chromeBinaryAsync } = await import("../lib/chrome.ts");
    const dir = temp();
    const chrome = join(dir, "chrome");
    const log = join(dir, "installs.log");
    const flag = join(dir, "install-fails");
    // Stands in for @puppeteer/browsers: logs each run, fails while the flag file exists.
    write(dir, {
      chrome: "",
      "bin/bunx": `#!/bin/sh\necho run >> "${log}"\nsleep 0.3\n[ -e "${flag}" ] && exit 1\necho "${chrome}"\n`,
      "install-fails": "",
    });
    chmodSync(join(dir, "bin/bunx"), 0o755);
    const runs = () => readFileSync(log, "utf-8").split("\n").filter(Boolean).length;
    const saved = { ...process.env };
    process.env.PATH = `${join(dir, "bin")}:${process.env.PATH}`;
    process.env.PUPPETEER_CACHE_DIR = join(dir, "empty-cache");
    delete process.env.CHROME_BINARY;
    try {
      expect(await chromeBinaryAsync()).toBeUndefined();
      rmSync(flag);
      expect(await Promise.all([chromeBinaryAsync(), chromeBinaryAsync()])).toEqual([
        chrome,
        chrome,
      ]);
      expect(runs()).toBe(2);
      expect(await chromeBinaryAsync()).toBe(chrome);
      expect(runs()).toBe(2);
    } finally {
      process.env = saved;
    }
  });
});

describe("serve", () => {
  test("two servers started at once get their own ports; one that exits fails at once", async () => {
    const { serve } = await import("../lib/serve.ts");
    const app = join(temp(), "app.ts");
    writeFileSync(
      app,
      "Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => new Response(process.env.PORT) });\n",
    );
    const [a, b] = await Promise.all([
      serve([process.execPath, app]),
      serve([process.execPath, app]),
    ]);
    try {
      expect(a.url).not.toBe(b.url);
      expect(await (await fetch(a.url)).text()).toBe(new URL(a.url).port);
      expect(await (await fetch(b.url)).text()).toBe(new URL(b.url).port);
    } finally {
      a.stop();
      b.stop();
    }
    const started = Date.now();
    await expect(serve([process.execPath, "-e", "process.exit(3)"])).rejects.toThrow("it exited");
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(serve(["/nonexistent-polish-bin"])).rejects.toThrow("it exited");
  });

  test("a server that accepts but never answers fails at the timeout", async () => {
    const { serve } = await import("../lib/serve.ts");
    const silent = `require("node:net").createServer(() => {}).listen(Number(process.env.PORT), process.env.HOST)`;
    const started = Date.now();
    await expect(serve([process.execPath, "-e", silent], { timeoutMs: 500 })).rejects.toThrow(
      "no answer",
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});
