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
import { pathToFileURL } from "node:url";
import { catalogPath } from "../catalog/path.ts";

const bin = (name: string) => join(import.meta.dir, "..", "bin", `${name}.ts`);
const made: string[] = [];
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "scaffolding-test-"));
  made.push(dir);
  return dir;
}
/** A headless Chrome on a free debugging port with one tab open at `url`, driven over CDP. The
 * unused debugging pipe on fds 3 and 4 closes when this process dies, killed by a signal included,
 * where no `finally` runs, and Chrome quits on that. */
async function browse(url: string, args: string[] = []) {
  const { chromeArgs, chromeBinary, INSTALL_HINT } = await import("../lib/chrome.ts");
  const { freePort } = await import("../lib/serve.ts");
  const chrome = chromeBinary();
  if (!chrome) throw new Error(INSTALL_HINT);
  const port = await freePort();
  const browser = Bun.spawn(
    [
      chrome,
      ...chromeArgs(temp()),
      `--remote-debugging-port=${port}`,
      "--remote-debugging-pipe",
      ...args,
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  let ws: WebSocket;
  try {
    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 100 && !target; i++)
      target = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })
        .then((r) => r.json())
        .catch(() => new Promise((r) => setTimeout(r, 100)));
    ws = new WebSocket(target!.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  } catch (e) {
    browser.kill();
    throw e;
  }
  let id = 0;
  const send = (method: string, params: object = {}) =>
    new Promise<{ value?: unknown }>((done) => {
      const call = ++id;
      const on = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== call) return;
        ws.removeEventListener("message", on);
        done(message.result?.result ?? {});
      };
      ws.addEventListener("message", on);
      ws.send(JSON.stringify({ id: call, method, params }));
    });
  const evaluate = async (expression: string) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true })).value;
  const until = async (expression: string) => {
    for (const end = Date.now() + 20_000; Date.now() < end;) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out: ${expression}`);
  };
  const close = () => {
    ws.close();
    browser.kill();
  };
  return { ws, send, evaluate, until, close };
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
  const r = spawnSync(process.execPath, ["--no-env-file", bin(name), ...args], {
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

const installed =
  "hard-coded path into an installed package: import.meta.resolve it through the package's exports (its ./package.json for the folder), run its command from node_modules/.bin, serve a catalog asset by its package path in the preset's copy, or name the exception in scaffolding.allow";

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
        exports: { "./tokens.css": "./tokens/tokens.css", "./fonts/*": "./tokens/fonts/*" },
      }),
      "src/fonts.css":
        '@font-face { src: url("../node_modules/@hackersandwizards/brand/tokens/fonts/inter.woff2"); }\n@font-face { src: url(../node_modules/@hackersandwizards/brand/fonts/inter.woff2); }\n@import "../node_modules/@hackersandwizards/brand/tokens.css";\n',
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
      `[check-coupling] src/deck-disk.ts: ${installed} (node_modules/@hackersandwizards/slides/styles/slides.css)`,
      "[check-coupling] src/deck-other.css: styles come from brand's exports, an engine's scaffolding.styles or this repository (@hackersandwizards/slides/styles/x.css)",
      `[check-coupling] src/deep.astro: ${installed} (node_modules/@hackersandwizards/brand/expert/expert.css)`,
      "[check-coupling] src/fonts.css: a stylesheet names a disk path only to a file @hackersandwizards/brand exports (node_modules/@hackersandwizards/brand/fonts/inter.woff2)",
      "[check-coupling] src/fonts.css: not in the exports of @hackersandwizards/brand (@hackersandwizards/brand/tokens.css)",
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
      "tools/fonts.py":
        '# node_modules/@hackersandwizards/brand\ndef f():\n    """Reads node_modules/@hackersandwizards/brand."""\nCMD = [\n    """node_modules/@hackersandwizards/brand/data""",\n]\nBRAND = \'node_modules/@hackersandwizards/brand/tokens/fonts\'\nLOGOS = ROOT / \'node_modules\' / \'@hackersandwizards\' / \'brand\' / \'logos\'\nMARKS = Path("node_modules") / "@hackersandwizards"\n',
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
    expect(lines(run(dir, "check-coupling").out, "check-coupling").sort()).toEqual([
      `[check-coupling] mails/brief.json: ${installed} (node_modules/@hackersandwizards/brand/logos/avatar.png)`,
      `[check-coupling] og/template.html: ${installed} (node_modules/@hackersandwizards/brand/logos/lockup.svg)`,
      `[check-coupling] og/template.html: ${installed} (node_modules/@hackersandwizards/brand/tokens/fonts.css)`,
      `[check-coupling] og/template.html: ${installed} (node_modules/@hackersandwizards/brand/tokens/fonts/inter.woff2)`,
      `[check-coupling] package.json: ${installed} (node_modules/@hackersandwizards/brand/logos/w.svg)`,
      `[check-coupling] scripts/fonts.sh: ${installed} (node_modules/@hackersandwizards/brand/tokens/fonts/x.woff2)`,
      `[check-coupling] src/Page.astro: ${installed} (node_modules/@hackersandwizards/brand/logos/mark.svg)`,
      `[check-coupling] src/after-source.ts: ${installed} (node_modules/@hackersandwizards/brand/x.svg)`,
      `[check-coupling] src/logos.ts: ${installed} (node_modules/@hackersandwizards/brand/clients/)`,
      `[check-coupling] src/regex.ts: ${installed} (node_modules/@hackersandwizards/brand/c/)`,
      `[check-coupling] src/root.ts: ${installed} (node_modules/@hackersandwizards/brand)`,
      `[check-coupling] src/scope.ts: ${installed} (node_modules/@hackersandwizards/)`,
      `[check-coupling] src/segments.ts: ${installed} (node_modules", "@hackersandwizards)`,
      `[check-coupling] test/story.test.ts: ${installed} (node_modules/@hackersandwizards/slides)`,
      `[check-coupling] tools/fonts.py: ${installed} (node_modules") / "@hackersandwizards)`,
      `[check-coupling] tools/fonts.py: ${installed} (node_modules' / '@hackersandwizards)`,
      `[check-coupling] tools/fonts.py: ${installed} (node_modules/@hackersandwizards/brand/data)`,
      `[check-coupling] tools/fonts.py: ${installed} (node_modules/@hackersandwizards/brand/tokens/fonts)`,
    ]);
  });

  test("a comment touching the code is no path, and a glob in a string hides none", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "fx" }),
      "src/a.css": "a{b:c;}/* node_modules/@hackersandwizards/brand/x.woff2 */\n",
      "src/b.ts":
        'const g = "src/*.ts";\nconst p = "node_modules/@hackersandwizards/brand/x.svg"; // */\n',
    });
    expect(lines(run(dir, "check-coupling").out, "check-coupling")).toEqual([
      `[check-coupling] src/b.ts: ${installed} (node_modules/@hackersandwizards/brand/x.svg)`,
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
    for (const reason of ["", true])
      expect(run(allow([{ ...reasoned, reason }]), "check-coupling").out).toContain(
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
  // --fix stages the mode alone, never an uncommitted edit.
  sh(dir, ["update-index", "--chmod=-x", "bin/x.ts"]);
  writeFileSync(join(dir, "bin/x.ts"), "#!/usr/bin/env bun\nedited;\n");
  run(dir, "check-structure", ["--fix"]);
  expect(sh(dir, ["ls-files", "-s", "bin/x.ts"]).stdout.toString()).toStartWith(
    `100755 ${sh(dir, ["rev-parse", "HEAD:bin/x.ts"]).stdout.toString().trim()} `,
  );
});

test("every bin target and every file in bin/ is stored executable", () => {
  const root = join(import.meta.dir, "..");
  const stored = new Map(
    sh(root, ["ls-files", "-s", "--", "bin", "README.md"])
      .stdout.toString()
      .trim()
      .split("\n")
      .map((line) => {
        const [entry, path] = line.split("\t");
        return [path, entry.split(" ")[0]];
      }),
  );
  // Control: the same read of a file stored plain has to answer 100644.
  expect(stored.get("README.md")).toBe("100644");
  stored.delete("README.md");
  const { bin } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(Object.values<string>(bin).filter((path) => !stored.has(path))).toEqual([]);
  expect([...stored].filter(([, mode]) => mode !== "100755")).toEqual([]);
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

  test("a full repository has its catalog, brand and admin on their newest tags", () => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.devDependencies["@hackersandwizards/brand"]).toBe(
      "github:hackersandwizards/brand#v0.10.0",
    );
    expect(pkg.devDependencies["@hackersandwizards/admin"]).toBe(
      "github:hackersandwizards/admin#v0.10.0",
    );
    expect(pkg.scaffolding.skip).toEqual({ test: "new repository: no tests yet" });
    expect(pkg.scripts.build).toBe("check-lock bun --bun astro build --root catalog");
    expect(pkg.scripts["check:retired"]).toBe("brand-retired dist");
    expect(pkg.scaffolding.check).toEqual(["check:retired"]);
    // Under an agent `astro preview` moves into the background, which resolves --root catalog from
    // inside catalog/ and finds no catalog/catalog/dist.
    expect(pkg.scripts.preview).toBe(
      "ASTRO_PREVIEW_BACKGROUND=1 bun --bun astro preview --root catalog",
    );
    const config = readFileSync(join(dir, "catalog/astro.config.ts"), "utf8");
    expect(config).toContain('base: "/demo"');
    expect(config).toContain("port: 4655 }");
    expect(readFileSync(join(dir, ".github/workflows/pages.yml"), "utf8")).toContain(
      `uses: hackersandwizards/scaffolding/.github/workflows/pages.yml@v${ownVersion}\n`,
    );
    // No placeholder item: the hub would list it as the repository's open goal.
    expect(readdirSync(join(dir, "docs/agent-work"))).toEqual([".gitkeep"]);
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
    expect(pkg.scaffolding.check).toEqual([]);
    expect(pkg.scripts["check:retired"]).toBeUndefined();
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
    // false gives no reason, as a missing skip.catalog does.
    pkg.scaffolding.skip.catalog = false;
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

  test("each scan reads the allow list of the snapshot it scans", () => {
    const entry = { check: "confidential", path: "people/jane/*", reason: "her own entry" };
    const pkg = (allow: object[]) => JSON.stringify({ scaffolding: { allow } });
    const audit = (dir: string, args = ["--index"]) =>
      run(dir, "check-confidential", args, env).out;
    const dir = repo({ "package.json": pkg([]), "a.md": "nothing\n" });
    // A commit adding a name's folder with its entry: the gate audits the index, HEAD has neither.
    write(dir, { "package.json": pkg([entry]), "people/jane/a.md": "Jane Q Doe\n" });
    sh(dir, ["add", "package.json", "people/jane/a.md"]);
    expect(audit(dir)).toBe("");
    expect(audit(dir, ["--tree", "HEAD"])).toBe("");
    // The staged entry covers the staged name while the working tree drops it.
    write(dir, { "package.json": pkg([]) });
    expect(audit(dir, ["--staged"])).toBe("");
    // The entry only in the working tree covers nothing staged.
    sh(dir, ["add", "package.json"]);
    write(dir, { "package.json": pkg([entry]) });
    expect(audit(dir, ["--staged"])).toContain("(Jane Q Doe)");
    sh(dir, ["add", "package.json"]);
    sh(dir, ["commit", "-qm", "jane"]);
    // A commit removing both: the index holds neither, HEAD both.
    sh(dir, ["rm", "-q", "people/jane/a.md"]);
    write(dir, { "package.json": pkg([]) });
    sh(dir, ["add", "package.json"]);
    expect(audit(dir)).toBe("");
    expect(audit(dir, ["--tree", "HEAD"])).toBe("");
    // A name already committed, its entry staged: the commit adding the entry passes the gate.
    const named = repo({ "package.json": pkg([]), "people/jane/a.md": "Jane Q Doe\n" });
    expect(audit(named)).toContain("(Jane Q Doe)");
    write(named, { "package.json": pkg([entry]) });
    sh(named, ["add", "package.json"]);
    expect(audit(named)).toBe("");
    // A bad revision fails rather than read as a package without allow entries.
    expect(run(named, "check-confidential", ["--tree", "nope"], env).code).not.toBe(0);
    // An unmerged index has no single file to scan.
    sh(named, ["commit", "-qm", "entry"]);
    sh(named, ["checkout", "-qb", "side"]);
    write(named, { "a.md": "side\n" });
    sh(named, ["add", "a.md"]);
    sh(named, ["commit", "-qm", "side"]);
    sh(named, ["checkout", "-q", "-"]);
    write(named, { "a.md": "main\n" });
    sh(named, ["add", "a.md"]);
    sh(named, ["commit", "-qm", "main"]);
    spawnSync("git", ["merge", "-q", "side"], { cwd: named });
    expect(audit(named)).toContain("a.md: unmerged");
  });

  test("an entry's text is the whole term in any case; a longer term containing it stays red", () => {
    const entry = (text: string | string[]) => ({
      check: "confidential",
      text,
      reason: "test",
    });
    const audit = (text: string | string[], body: string) =>
      lines(
        run(
          repo({
            "package.json": JSON.stringify({ scaffolding: { allow: [entry(text)] } }),
            "a.md": body,
          }),
          "check-confidential",
          ["--tree", "HEAD"],
          env,
        ).out,
        "check-confidential",
      );
    expect(audit("Jane Q Doe".normalize("NFD"), "JANE Q DOE and jane q doe\n")).toEqual([]);
    expect(audit("Jane-Q. Doe", "Jane Q Doe\n")).toEqual([]);
    expect(audit("Acme Widgets", "Acme Widgets GmbH\n")).toEqual([
      "[check-confidential] a.md: confidential term from the company records (Acme Widgets GmbH)",
    ]);
    expect(
      audit(
        ["jane q doe", "acme widgets gmbh", "acme widgets", "zyx"],
        "Jane Q Doe, Acme Widgets GmbH\n",
      ),
    ).toEqual([
      `[check-confidential] package.json: allow entry matches nothing (${JSON.stringify(entry("zyx"))})`,
    ]);
  });

  test("one entry's path list covers a person's folder, file names and package.json", () => {
    const allow = [
      {
        check: "confidential",
        path: ["people/jane-q-doe/**", "file names", "package.json", "gone/**"],
        text: "Jane Q Doe",
        reason: "test",
      },
    ];
    const out = run(
      repo({
        "package.json": JSON.stringify({ scaffolding: { allow } }),
        "people/jane-q-doe/index.md": "Jane Q Doe\n",
        "other.md": "Jane Q Doe\n",
      }),
      "check-confidential",
      ["--tree", "HEAD"],
      env,
    ).out;
    expect(lines(out, "check-confidential")).toEqual([
      "[check-confidential] other.md: confidential term from the company records (Jane Q Doe)",
      // Each path of the list dies with its own case.
      `[check-confidential] package.json: allow entry matches nothing (${JSON.stringify({ ...allow[0], path: "gone/**" })})`,
    ]);
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
    // A merge whose resolution alone changes a lockable path.
    const merged = repo({
      "package.json": "{}",
      ".gitattributes": "*.psd lockable\n",
      "a.psd": "x",
    });
    sh(merged, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    sh(merged, ["checkout", "-qb", "side"]);
    sh(merged, ["commit", "-q", "--allow-empty", "-m", "c"]);
    sh(merged, ["checkout", "-q", "main"]);
    sh(merged, ["commit", "-q", "--allow-empty", "-m", "d"]);
    sh(merged, ["merge", "-q", "--no-commit", "side"]);
    write(merged, { "a.psd": "y" });
    sh(merged, ["commit", "-qam", "m"]);
    expect(both(merged)).toEqual([3, 1]);
    expect(logged()).toBe(
      "pre-push origin x\n".repeat(3) + "pre-push backup x\n" + "pre-push origin x\n".repeat(3),
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
  const gate = (scaffolding: object, scripts: Record<string, string> = {}, extra: object = {}) =>
    repo({
      "package.json": JSON.stringify({
        name: "fx",
        type: "module",
        scripts,
        scaffolding,
        ...extra,
      }),
    });
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
    history: "t",
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

  test("no step sees a variable only .env set, a nested bun included", () => {
    const probe = `sh -c 'echo sh=\${SCAF_TEST_SECRET:-none}' && bun probe.ts`;
    const dir = gate({ skip, check: ["check:probe"] }, { "check:probe": probe });
    write(dir, {
      ".env": "SCAF_TEST_SECRET=x\n",
      "probe.ts": 'console.log(`bun=${process.env.SCAF_TEST_SECRET ?? "none"}`);\n',
    });
    // The parent gate hands its own BUN_OPTIONS down; each run here starts without it.
    const { BUN_OPTIONS: _, ...bare } = process.env;
    const env = { ...bare, CHECK_LOCK: join(dir, ".lock") };
    const plain = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: dir, env, encoding: "utf8" });
    // Control: outside the gate, bun loads .env.
    expect(plain(process.execPath, ["probe.ts"]).stdout).toContain("bun=x");
    for (const r of [
      plain(process.execPath, ["--no-env-file", bin("scaffolding"), "check"]),
      plain(bin("scaffolding"), ["check"]),
    ]) {
      const out = `${r.stdout}${r.stderr}`;
      expect(out).toContain("sh=none");
      expect(out).toContain("bun=none");
      expect(r.status).toBe(0);
    }
    for (const name of ["scaffolding", "check-staged"]) {
      const loaded = plain(process.execPath, [bin(name), "check"]);
      expect(loaded.status).toBe(2);
      expect(loaded.stderr).toContain("--no-env-file");
    }
  });

  test("a failing step fails the gate and stops the later ones", () => {
    const dir = gate({ skip, check: ["false", "echo never-ran"] });
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL false");
    expect(r.out).not.toContain("never-ran");
  });

  test("a gate pinning brand goes red without check:retired unless the skip gives a reason", () => {
    const pin = {
      devDependencies: { "@hackersandwizards/brand": "github:hackersandwizards/brand#v1.0.0" },
    };
    const branded = (scaffolding: object, scripts: Record<string, string> = {}) =>
      gate(scaffolding, scripts, pin);
    const lock = (d: string) => ({ CHECK_LOCK: join(d, ".lock") });
    const bare = branded({ skip });
    const r = run(bare, "scaffolding", ["check"], lock(bare));
    expect(r.code).toBe(1);
    expect(r.out).toContain("scaffolding.check runs no check:retired");
    const listed = branded(
      { skip, check: [["check:retired", "true"]] },
      { "check:retired": "echo ran-retired" },
    );
    const ok = run(listed, "scaffolding", ["check"], lock(listed));
    expect(ok.out).toContain("ran-retired");
    expect(ok.code).toBe(0);
    const skipped = branded({ skip: { ...skip, retired: "brand only in tests" } });
    expect(run(skipped, "scaffolding", ["check"], lock(skipped)).code).toBe(0);
    const blank = branded({ skip: { ...skip, retired: " " } });
    expect(run(blank, "scaffolding", ["check"], lock(blank)).out).toContain("no check:retired");
    const unpinned = gate({ skip: { ...skip, retired: "brand only in tests" } });
    expect(run(unpinned, "scaffolding", ["check"], lock(unpinned)).out).toContain(
      "scaffolding.skip names no shared step: retired",
    );
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

  test("the catalog build starts once a typecheck running Astro has finished", () => {
    const { catalog: _, typecheck: __, ...rest } = skip;
    const dir = gate(
      { skip: rest, typecheck: "check:types" },
      // A script name whose body runs Astro counts as Astro.
      { "check:types": "sleep 1 && touch tc-done && echo astro", build: "test -f tc-done" },
    );
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.out).toContain("ok   catalog");
    expect(r.code).toBe(0);
    // A typecheck without Astro shares no cache with the build, which starts beside it.
    const beside = gate(
      { skip: rest, typecheck: "tc" },
      { tc: "sleep 3 && touch tc-done", build: "test ! -f tc-done" },
    );
    const b = run(beside, "scaffolding", ["check"], { CHECK_LOCK: join(beside, ".lock") });
    expect(b.out).toContain("ok   catalog");
    const failed = gate(
      { skip: rest, typecheck: "astro" },
      { astro: "exit 1", build: "echo built" },
    );
    const f = run(failed, "scaffolding", ["check"], { CHECK_LOCK: join(failed, ".lock") });
    expect(f.out).toContain("FAIL typecheck");
    expect(f.out).toContain("ok   catalog");
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

  test("a skip whose value is no text gives no reason", () => {
    for (const lint of [false, 0, {}, true]) {
      const dir = gate({ skip: { ...skip, lint } });
      const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
      expect(r.out).toContain("scaffolding.skip.lint has no reason");
      expect(r.code).toBe(1);
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

  test("the preset builds the shell's home into the repository's dist/", async () => {
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
    // `nav`: an href from "/" counts from the base, the current item links to /catalog/, which
    // forwards to the home.
    expect(home).toContain(
      '<header class="fx-header"><a href="/">Fx</a><div class="hw-header-nav hw-catalog-nav"><nav class="hw-header-nav" aria-label="Main" data-hw-catalogs><a class="hw-header-link" href="/">Site</a><a class="hw-header-link" href="/catalog/" aria-current="page">Fx</a><a class="hw-header-link" href="https://example.com/other/">Other</a><a class="hw-header-link" href="//example.com/far/">Far</a></nav></div></header>',
    );
    expect(home).toContain("fx catalog/stories · 3 components · 24 states");
    // The admin hub serves only on this machine: a built page carries no link to it.
    expect(home).not.toContain("admin.localhost");
    expect(home.indexOf(">Types <")).toBeLessThan(home.indexOf(">Parts <"));
    // The rail names every element under its group, linked to the state its tile draws.
    expect(home).toMatch(
      /<ul class="hw-catalog-names"><li><a href="\/dashboard\/Parts\/box-parts\/two\/">Box parts<\/a>/,
    );
    // A frame names its page in data-src: the shell's script loads it once the tile nears the view.
    expect(home).toContain('data-src="/stories/Types/box-types/two/"');
    expect(home).not.toMatch(/<iframe[^>]* src=/);
    expect(readdirSync(join(dist, "stories/Parts/box-parts"))).toEqual(["one", "two"]);
    // `previewSize` per group: a Types tile draws its frame whole at 1440 x 900, a Parts tile at
    // three quarters.
    expect(home).toContain(
      'data-frame-width="1440" style="aspect-ratio:1440/900"><iframe data-src="/stories/Types/box-types/two/"',
    );
    expect(home).toMatch(/<span class="hw-catalog-preview"><iframe data-src="\/stories\/Parts\//);
    // The shell's own card, pill and rail (brand's search field and navigation list) carry
    // data-hw-shell, for brand-elements to skip.
    expect(home).toContain(
      '<aside class="hw-catalog-rail" data-hw-shell><div class="hw-search"><input class="hw-field hw-catalog-search" type="search"',
    );
    expect(home).toContain('<nav class="hw-nav" aria-label="Groups">');
    expect(home).toContain('<a class="hw-card hw-catalog-tile" data-hw-shell href=');
    expect(home).toContain('<span class="hw-pill" data-tone="neutral" data-hw-shell>');
    expect(readFileSync(join(dist, "fx.txt"), "utf8")).toBe("fx\n");
    const page = (p: string) => readFileSync(join(dist, p, "index.html"), "utf8");
    // No page carries a robots tag; the shell draws dense, a story at `storyScale`, and every page but a
    // state alone turns with the theme toggle.
    const root = (html: string) =>
      html.match(/Object\.assign\(document\.documentElement\.dataset,(\{.*?\})\);/)?.[1];
    expect(root(home)).toBe('{"hwScale":"dense","hwNight":""}');
    expect(root(page("dashboard/Parts/box-parts/two"))).toBe('{"hwScale":"screen","hwNight":""}');
    expect(root(page("stories/Parts/box-parts/two"))).toBe('{"hwScale":"screen"}');
    const robots = /<meta\b[^>]*\bname\s*=\s*["']?robots\b/i;
    for (const p of [
      "",
      "dashboard/Parts/box-parts/two",
      "stories/Parts/box-parts/two",
      "catalog",
      "catalog/dashboard/Parts/box-parts/two",
    ])
      expect(page(p)).not.toMatch(robots);
    for (const p of ["", "dashboard/Parts/box-parts/two", "stories/Parts/box-parts/two"])
      expect(page(p)).toContain('<meta name="description" content="Lead.">');
    // A state whose args carry a lead describes itself by it.
    for (const p of ["dashboard/Parts/box-parts/one", "stories/Parts/box-parts/one"])
      expect(page(p)).toContain('<meta name="description" content="The first box.">');
    // Without a `site` the canonical URL is root-relative; a state alone names the state's page.
    const links = (html: string, rel: string) =>
      [...html.matchAll(new RegExp(`<link rel="${rel}" href="([^"]*)"`, "g"))].map((m) => m[1]);
    expect(links(home, "canonical")).toEqual(["/"]);
    for (const p of ["dashboard/Parts/box-parts/two", "stories/Parts/box-parts/two"])
      expect(links(page(p), "canonical")).toEqual(["/dashboard/Parts/box-parts/two/"]);
    // The shell paints the ground from brand's role or token; the fixture's home loads no token,
    // so the page sets them. A story's own stylesheet still wins on a state's page.
    const served = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const { pathname } = new URL(req.url);
        return new Response(
          Bun.file(join(dist, pathname, pathname.endsWith("/") ? "index.html" : "")),
        );
      },
    });
    const painted = await browse(`${served.url}`);
    try {
      await painted.until(
        `document.readyState === "complete" && !!document.querySelector(".hw-catalog")`,
      );
      const ground = () =>
        painted.evaluate(`getComputedStyle(document.documentElement).backgroundColor`);
      expect(await ground()).toBe("rgba(0, 0, 0, 0)");
      for (const [step, colour] of [
        [
          `document.documentElement.style.setProperty("--color-bg", "rgb(1, 2, 3)")`,
          "rgb(1, 2, 3)",
        ],
        [
          `document.documentElement.style.setProperty("--background", "rgb(4, 5, 6)")`,
          "rgb(4, 5, 6)",
        ],
        [
          `document.head.insertAdjacentHTML("beforeend", "<style>@layer base { html { background: rgb(7, 8, 9); } }</style>")`,
          "rgb(7, 8, 9)",
        ],
      ] as const) {
        await painted.evaluate(step);
        expect(await ground()).toBe(colour);
      }
    } finally {
      painted.close();
      void served.stop(true);
    }
    // Every page of the catalog's former place forwards to its page at the root.
    expect(page("catalog/dashboard/Parts/box-parts/two")).toContain(
      'http-equiv="refresh" content="0; url=/dashboard/Parts/box-parts/two/"',
    );
    expect(page("catalog")).toContain('content="0; url=/"');
    const state = page("dashboard/Parts/box-parts/two");
    // Each page's own styles: its <style> blocks and the stylesheets it links.
    const styles = (html: string) =>
      [
        ...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g).map((m) => m[1]),
        ...html
          .matchAll(/<link rel="stylesheet" href="\/_astro\/([^"]+)"/g)
          .map((m) => readFileSync(join(dist, "_astro", m[1]!), "utf8")),
      ].join("");
    expect(state).toContain('<meta name="fx-head" content="repository">');
    expect(styles(state)).toMatch(
      /#astrobook-sidebar,\s*astrobook-sidebar-resize-handle\s*\{\s*display:\s*none\s*!important/,
    );
    // A state's page takes the header's, the bar's and the repository's CSS; a state alone only the
    // repository's; the home the header's and the shell's, and of the repository's only `homeCss`.
    const [stateCss, aloneCss, homeCss] = [state, page("stories/Parts/box-parts/two"), home].map(
      styles,
    );
    for (const rule of [".fx-header{display:flex}", ".hw-catalog-bar{", ".box{color:teal}"])
      expect(stateCss).toContain(rule);
    expect(aloneCss).toContain(".box{color:teal}");
    for (const rule of [".fx-header{", "hw-catalog-bar", "hw-catalog-nav", "astrobook-sidebar,"])
      expect(aloneCss).not.toContain(rule);
    expect(homeCss).toContain(".fx-header{display:flex}");
    expect(homeCss).toContain(".hw-catalog-grid{");
    expect(homeCss).not.toContain(".box{");
    const barOf = (html: string) =>
      html.match(/<template id="hw-catalog-bar">([\s\S]*?)<\/template>/)?.[1] ?? "";
    const bar = barOf(state);
    // A state's page carries the header above the bar, the current item marked as the place, not
    // the page.
    expect(bar).toStartWith(
      '<div data-hw-catalog-top><header class="fx-header"><a href="/">Fx</a><div class="hw-header-nav hw-catalog-nav"><nav class="hw-header-nav" aria-label="Main" data-hw-catalogs><a class="hw-header-link" href="/">Site</a><a class="hw-header-link" href="/catalog/" aria-current="true">Fx</a><a class="hw-header-link" href="https://example.com/other/">Other</a><a class="hw-header-link" href="//example.com/far/">Far</a></nav></div></header></div><nav class="hw-catalog-bar"',
    );
    expect(bar).toContain('<nav class="hw-catalog-bar" aria-label="Catalog">');
    expect(bar).toContain('<a href="/catalog/"><span aria-hidden="true">');
    expect(bar).toMatch(/Parts \/ <strong>Box parts<\/strong>/);
    expect(bar).toContain('<button type="button" data-hw-theme aria-pressed="false">');
    expect(bar).toMatch(
      /<a class="hw-catalog-tool" href="\/stories\/Parts\/box-parts\/two\/">\s*Open this state alone\s*<\/a>/,
    );
    expect(bar).toContain('<ul aria-label="States">');
    expect(bar).toMatch(/href="\/dashboard\/Parts\/box-parts\/one\/">One/);
    expect(bar).toMatch(/href="\/dashboard\/Parts\/box-parts\/two\/" aria-current="page">Two/);
    expect(bar).toContain(
      '<a class="hw-catalog-step" rel="prev" href="/dashboard/Parts/box-parts/one/"',
    );
    // A step with nowhere to go is no anchor: Lighthouse's crawlable-anchors fails one without href.
    expect(bar).toContain(
      '<button class="hw-catalog-step" type="button" disabled aria-label="Next state">',
    );
    const first = barOf(page("dashboard/Parts/box-parts/one"));
    expect(first).toContain(
      '<button class="hw-catalog-step" type="button" disabled aria-label="Previous state">',
    );
    expect(first).toContain(
      '<a class="hw-catalog-step" rel="next" href="/dashboard/Parts/box-parts/two/"',
    );
    expect(`${bar}${first}`).not.toMatch(/<a(?![^>]*href)[^>]*>/);
    expect(bar).toContain("2 of 2");
    // Above 12 states a menu replaces the chips, grouped by a word three names share.
    const many = barOf(page("dashboard/Parts/many-parts/block-image"));
    expect(many).not.toContain("<ul");
    expect(many).toContain(
      '<optgroup label="Block"><option value="/dashboard/Parts/many-parts/block-code/">Block code</option><option value="/dashboard/Parts/many-parts/block-image/" selected>Block image</option>',
    );
    expect(many).toContain(
      '<optgroup label="Theme"><option value="/dashboard/Parts/many-parts/accent-theme/">Accent theme</option>',
    );
    expect(many).toContain(
      '</optgroup><option value="/dashboard/Parts/many-parts/angebot-ohne-preise/">Angebot ohne Preise</option>',
    );
    // A camelCase state reads in sentence case, an acronym kept; a name with underscores keeps its
    // author's case. Either way the first word is capitalised.
    expect(many).toMatch(/many-parts\/density-on-pdf\/">Density on PDF</);
    expect(many).toMatch(/">Folie 35 Eine Woche zum</);
    expect(many).toMatch(/">In German</);
    // So a German noun after the first word needs an underscore name.
    expect(many).toMatch(/">Mit impressum</);
    expect(many).toMatch(/">Primary on night</);
    // A plural acronym and a listed name with inner capitals stay whole.
    expect(many).toMatch(/many-parts\/two-pd-fs\/">Two PDFs</);
    expect(many).toMatch(/many-parts\/loading-git-hub\/">Loading GitHub</);
    expect(state).toContain("if (top) main.before(top);");
    expect(page("stories/Parts/box-parts/two")).not.toContain('id="hw-catalog-bar"');
    expect(home).not.toContain('id="hw-catalog-bar"');
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
    expect(based).toContain(
      '<header class="fx-header"><a href="/fx/">Fx</a><div class="hw-header-nav hw-catalog-nav"><nav class="hw-header-nav" aria-label="Main" data-hw-catalogs><a class="hw-header-link" href="/fx/">Site</a><a class="hw-header-link" href="/fx/catalog/" aria-current="page">Fx</a><a class="hw-header-link" href="https://example.com/other/">Other</a><a class="hw-header-link" href="//example.com/far/">Far</a></nav></div></header>',
    );
    expect(based).toContain('data-src="/fx/stories/Types/box-types/two/"');
    expect(page("catalog/stories/Types/box-types/two")).toContain(
      'url=/fx/stories/Types/box-types/two/"',
    );
    // A base ending in /catalog mounts the catalog under a host with its own home: no forwarding
    // pages and no public/, which the host serves.
    expect(build(["--base", "/catalog"]).status).toBe(0);
    const mountedHome = readFileSync(join(dist, "index.html"), "utf8");
    expect(mountedHome).toContain('data-src="/catalog/stories/Types/box-types/two/"');
    // Its home reads /catalog/ already: the current item links there, not to /catalog/catalog/.
    expect(mountedHome).toContain(
      '<a class="hw-header-link" href="/catalog/" aria-current="page">Fx</a>',
    );
    expect(page("dashboard/Parts/box-parts/two")).toContain(
      '<a href="/catalog/"><span aria-hidden',
    );
    expect(existsSync(join(dist, "catalog"))).toBe(false);
    expect(existsSync(join(dist, "fx.txt"))).toBe(false);
    // An outDir the config sets stays; only Astro's default moves to the repository's dist/.
    const custom = join(fixture, "catalog", "custom");
    made.push(custom);
    expect(build(["--outDir", "./custom"]).status).toBe(0);
    expect(existsSync(join(custom, "index.html"))).toBe(true);
    // A story link ends where Astro writes its page: no slash where a page is a file of its own,
    // unless the site asks for one.
    const files = join(fixture, "catalog", "files.config.mjs");
    made.push(files);
    for (const [slash, end] of [
      ["ignore", ""],
      ["always", "/"],
    ]) {
      writeFileSync(
        files,
        `import config from "./astro.config.mjs";\nexport default { ...config, trailingSlash: "${slash}", build: { format: "file" } };\n`,
      );
      expect(build(["--config", "files.config.mjs"]).status).toBe(0);
      expect(readFileSync(join(dist, "index.html"), "utf8")).toContain(
        `<li><a href="/dashboard/Parts/box-parts/two${end}">Box parts</a>`,
      );
    }
    rmSync(files);
    // A build with a file-URL assetsPrefix is opened from disk: every link to a page or file of the
    // build names its file by file URL, the home's frames, a copied file and a state menu's options
    // included; a link outside the build stays, and no page forwards from /catalog/.
    const disk = join(fixture, "catalog", "disk.config.mjs");
    made.push(disk);
    writeFileSync(
      disk,
      `import config from "./astro.config.mjs";\nexport default { ...config, build: { assetsPrefix: ${JSON.stringify(pathToFileURL(`${dist}/`).href)} } };\n`,
    );
    expect(build(["--config", "disk.config.mjs"]).status).toBe(0);
    const onDisk = readFileSync(join(dist, "index.html"), "utf8");
    const at = (p: string) => pathToFileURL(join(dist, p)).href;
    expect(onDisk).toContain(`<iframe data-src="${at("stories/Types/box-types/two/index.html")}"`);
    expect(onDisk).toContain(
      `<li><a href="${at("dashboard/Parts/box-parts/two/index.html")}">Box parts</a>`,
    );
    expect(onDisk).toContain(`<a href="${at("index.html")}">Fx</a>`);
    expect(onDisk).toContain(
      `<a class="hw-header-link" href="${at("index.html")}" aria-current="page">Fx</a>`,
    );
    expect(onDisk).toContain('href="https://example.com/other/"');
    expect(onDisk).not.toMatch(/\s(href|src|data-src)="\/(?!\/)/);
    expect(page("dashboard/Parts/box-parts/two")).toContain(
      `href="${at("stories/Parts/box-parts/two/index.html")}">Open this state alone`,
    );
    expect(onDisk).toContain(`<link rel="icon" href="${at("assets/logo.svg")}">`);
    // A build opened from disk is never published, and a file URL names the build machine.
    expect(onDisk).not.toContain('rel="canonical"');
    expect(page("dashboard/Parts/many-parts/block-image")).toContain(
      `<option value="${at("dashboard/Parts/many-parts/block-code/index.html")}">Block code</option>`,
    );
    expect(existsSync(join(dist, "catalog"))).toBe(false);
    rmSync(disk);
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
    // A `nav.current` naming no item fails the build by name.
    const misnamed = join(fixture, "catalog", "misnamed.config.mjs");
    made.push(misnamed);
    writeFileSync(
      misnamed,
      'import config from "./astro.config.mjs";\nimport { catalog } from "../../../catalog/index.ts";\nexport default { ...config, integrations: [catalog({ product: "Fx", css: [], lead: "", nav: { items: [{ name: "Fx", href: "/" }], current: "Fxx" } })] };\n',
    );
    const misnamedBuild = build(["--config", "misnamed.config.mjs"]);
    expect(misnamedBuild.status).not.toBe(0);
    expect(`${misnamedBuild.stdout}${misnamedBuild.stderr}`).toContain(
      'catalog nav: current "Fxx" names no item',
    );
    rmSync(misnamed);
    const variant = (name: string, options: string) => {
      const file = join(fixture, "catalog", `${name}.config.mjs`);
      made.push(file);
      writeFileSync(
        file,
        `import config from "./astro.config.mjs";\nimport { catalog } from "../../../catalog/index.ts";\nexport default { ...config, integrations: [catalog({ product: "Fx", css: [], lead: "", header: { component: "./Header.astro" }, ${options} })] };\n`,
      );
      const result = build(["--config", `${name}.config.mjs`]);
      rmSync(file);
      return result;
    };
    // A `previewSize` key naming no group fails the build by name: a renamed group would fall back
    // to the small fitted view unseen.
    const stale = variant("stale", "previewSize: { Parts: [1, 1], Pieces: [1440, 900] }");
    expect(stale.status).not.toBe(0);
    expect(`${stale.stdout}${stale.stderr}`).toContain(
      'catalog previewSize: "Pieces" names no story group (Parts, Types)',
    );
    // `themeToggle: false`: the bar offers no dark theme.
    expect(variant("light", "themeToggle: false").status).toBe(0);
    expect(page("dashboard/Parts/box-parts/two")).not.toContain(
      '<button type="button" data-hw-theme',
    );
    expect(root(page("dashboard/Parts/box-parts/two"))).toBe("{}");
    // With a `site` the canonical URL is absolute, under the base.
    expect(build(["--site", "https://fx.example", "--base", "/fx"]).status).toBe(0);
    expect(page("stories/Parts/box-parts/two")).toContain(
      '<link rel="canonical" href="https://fx.example/fx/dashboard/Parts/box-parts/two/"',
    );
    expect(page("")).toContain('<link rel="canonical" href="https://fx.example/fx/"');
    // Where the repository resolves brand, every page carries brand's favicon ahead of the
    // repository's head, whose own link then wins; without brand the shell writes none.
    expect(build().status).toBe(0);
    expect(links(page(""), "icon")).toEqual(["/assets/logo.svg"]);
    // The shell's home holds no foundations: no group of its own. A home with some draws them as
    // Foundations; beside a stories folder of that name the build fails, and a home of whitespace
    // and a comment leaves the folder the one group (compressHTML off, as in the repositories).
    expect(home).not.toContain('id="foundations"');
    const catalogDir = join(fixture, "catalog");
    const homed = join(catalogDir, "homed.config.mjs");
    const ownHome = join(catalogDir, "OwnHome.astro");
    const folder = join(catalogDir, "stories", "Foundations");
    made.push(homed, ownHome, folder);
    const ownHomeWith = (body: string) =>
      write(catalogDir, {
        "homed.config.mjs":
          'import config from "./astro.config.mjs";\nimport { catalog } from "../../../catalog/index.ts";\nexport default { ...config, compressHTML: false, integrations: [catalog({ product: "Fx", css: [], lead: "", header: { component: "./Header.astro" }, home: "./OwnHome.astro" })] };\n',
        "OwnHome.astro": `---\nimport Home from "../../../catalog/Home.astro";\n---\n\n<Home>${body}</Home>\n`,
      });
    ownHomeWith("<p>Tokens</p>");
    expect(build(["--config", "homed.config.mjs"]).status).toBe(0);
    expect(readFileSync(join(dist, "index.html"), "utf8")).toContain('id="foundations"');
    write(folder, {
      "Tokens.stories.js":
        'import Box from "../../Box.astro";\n\nexport default { component: Box };\nexport const One = { args: { label: "one" } };\n',
    });
    const twice = build(["--config", "homed.config.mjs"]);
    expect(twice.status).not.toBe(0);
    expect(`${twice.stdout}${twice.stderr}`).toContain(
      'catalog: the groups "Foundations" and "Foundations" both draw as #foundations',
    );
    ownHomeWith("\n  <!-- none yet -->\n");
    expect(build(["--config", "homed.config.mjs"]).status).toBe(0);
    const folderOnly = readFileSync(join(dist, "index.html"), "utf8");
    expect(folderOnly.match(/id="foundations"/g)).toHaveLength(1);
    expect(folderOnly).not.toContain("hw-catalog-text");
    rmSync(folder, { recursive: true });
    rmSync(homed);
    rmSync(ownHome);
    // Without `nav`, the header lists brand's catalogs.json, the one named as `product` current.
    const brand = join(fixture, "node_modules", "@hackersandwizards", "brand");
    const navless = join(fixture, "catalog", "navless.config.mjs");
    made.push(join(fixture, "node_modules"), navless);
    write(brand, {
      "package.json": JSON.stringify({
        exports: {
          "./catalogs.json": "./expert/catalogs.json",
          "./logos/*": "./logos/*",
          "./header.css": "./header.css",
          "./layers.css": "./tokens/layers.css",
          "./night.css": "./night.css",
          "./expert/components/*": "./expert/components/*",
        },
      }),
      "logos/favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
      // Over Vite's 4 KB inlining limit, so `?url` gives a file as with brand's own logo.
      "logos/lockup-screen.svg": `<svg xmlns="http://www.w3.org/2000/svg"><!--${"x".repeat(5000)}--></svg>`,
      "logos/night-logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"><!--${"y".repeat(5000)}--></svg>`,
      "header.css": "",
      "tokens/layers.css": "@layer properties, theme, base, components, utilities;\n",
      "night.css": "",
      "expert/components/AppHeader.astro":
        '---\nimport lockup from "../../logos/lockup-screen.svg?url";\nimport night from "../../logos/night-logo.svg?url";\n---\n\n<header class="hw-header"><img class="hw-header-logo" src={lockup} alt="" /><img src={night} alt="" loading="lazy" /><slot /></header>\n',
      "expert/catalogs.json": JSON.stringify([
        { name: "Other", href: "https://example.com/other/" },
        { name: "Fx", href: "https://example.com/fx/" },
      ]),
    });
    writeFileSync(
      navless,
      'import config from "./astro.config.mjs";\nimport { catalog } from "../../../catalog/index.ts";\nexport default { ...config, integrations: [catalog({ product: "Fx", css: [], lead: "" })] };\n',
    );
    expect(build(["--config", "navless.config.mjs"]).status).toBe(0);
    const branded = readFileSync(join(dist, "index.html"), "utf8");
    // brand's layer order follows the ground's.
    expect(branded).toContain(
      "<style>@layer hw-catalog-ground;@layer properties, theme, base, components, utilities;</style>",
    );
    expect(branded).toContain(
      '<nav class="hw-header-nav" aria-label="Main" data-hw-catalogs><a class="hw-header-link" href="https://example.com/other/">Other</a><a class="hw-header-link" href="/catalog/" aria-current="page">Fx</a></nav>',
    );
    // A state's page holds its header in a <template> the preload scanner skips, and only puts it
    // into <main> once the parser has waited out the stylesheets: the page fetches its logo before
    // they arrive, and leaves a logo marked lazy to the browser. The CSS answers once the logo is
    // asked for, 8 s at most, so a loaded machine cannot reorder the two.
    const order: string[] = [];
    let logoAsked = () => {};
    const asked = new Promise<void>((done) => (logoAsked = done));
    const slow = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const { pathname } = new URL(req.url);
        order.push(pathname);
        if (pathname.includes("lockup-screen")) logoAsked();
        if (pathname.endsWith(".css")) {
          await Promise.race([asked, Bun.sleep(8000)]);
          order.push("css arrived");
        }
        const path = join(dist, decodeURIComponent(pathname));
        return new Response(Bun.file(pathname.endsWith("/") ? join(path, "index.html") : path));
      },
    });
    const browsing = await browse(`${slow.url}dashboard/Parts/box-parts/two/`);
    try {
      await browsing.until(`document.querySelector("img.hw-header-logo")?.complete`);
      expect(order).toContain("css arrived");
      const early = order.slice(0, order.indexOf("css arrived")).join();
      expect(early).toContain("lockup-screen");
      expect(early).not.toContain("night-logo");
    } finally {
      browsing.close();
      void slow.stop(true);
    }
    rmSync(navless);
    expect(build().status).toBe(0);
    for (const p of ["", "stories/Parts/box-parts/two"]) {
      expect(links(page(p), "icon")).toEqual([
        expect.stringMatching(/^\/_astro\/favicon\..*\.svg$/),
        "/assets/logo.svg",
      ]);
    }
    rmSync(join(fixture, "node_modules"), { recursive: true });
    // The build adds no robots tag to a page of the repository's own; one with a tag of its own and
    // an endpoint's file stay as written.
    const src = join(fixture, "catalog", "src");
    const pages = join(src, "pages");
    made.push(src);
    mkdirSync(join(pages, "catalog"), { recursive: true });
    const head = (body: string) =>
      `<html lang="en"><head><title>t</title>${body}</head><body></body></html>\n`;
    writeFileSync(join(pages, "own.astro"), head(""));
    writeFileSync(join(pages, "kept.astro"), head('<meta name="robots" content="index">'));
    writeFileSync(
      join(pages, "raw.html.ts"),
      'export const GET = () => new Response("<html><head></head></html>");\n',
    );
    // An endpoint whose page should not be indexed writes its own tag.
    writeFileSync(
      join(pages, "tagged.html.ts"),
      `export const GET = () => new Response('<html><head><meta name="robots" content="noindex"></head></html>');\n`,
    );
    expect(build().status).toBe(0);
    expect(readFileSync(join(dist, "tagged.html"), "utf8")).toBe(
      '<html><head><meta name="robots" content="noindex"></head></html>',
    );
    expect(page("own")).toContain("<head><title>");
    expect(page("own")).not.toMatch(robots);
    expect(page("kept")).toMatch(robots);
    expect(page("kept")).toContain('<meta name="robots" content="index">');
    expect(page("kept")).not.toContain("noindex");
    expect(readFileSync(join(dist, "raw.html"), "utf8")).toBe("<html><head></head></html>");
    writeFileSync(join(pages, "headless.astro"), "<p>no head</p>\n");
    // A page without <head> builds.
    expect(build().status).toBe(0);
    expect(page("headless")).toContain("no head");
    expect(page("headless")).not.toMatch(robots);
    rmSync(join(pages, "headless.astro"));
    // A page of the site's own at /catalog/ beside a root catalog keeps its place: the catalog
    // links its home.
    writeFileSync(join(pages, "catalog", "index.astro"), head("<p>site catalog page</p>"));
    expect(build().status).toBe(0);
    expect(page("catalog")).toContain("site catalog page");
    expect(page("")).toContain('<a class="hw-header-link" href="/" aria-current="page">Fx</a>');
    rmSync(join(pages, "catalog", "index.astro"));
    // A site with a home page of its own keeps the catalog at /catalog/; no page gets a robots tag.
    writeFileSync(join(pages, "index.astro"), head("<p>site home</p>"));
    writeFileSync(join(pages, "catalog", "extra.astro"), head(""));
    expect(build().status).toBe(0);
    expect(page("").includes("site home")).toBe(true);
    expect(page("")).not.toMatch(robots);
    expect(page("own")).not.toMatch(robots);
    expect(page("catalog/extra")).not.toMatch(robots);
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
  // swaps pages in place, which drops both until a reload.
  test("dev serves `copy`, and a click in the bar loads the next state in full", async () => {
    const { serve } = await import("../lib/serve.ts");
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
    let page: Awaited<ReturnType<typeof browse>> | undefined;
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
      page = await browse(`${server.url}/dashboard/Parts/box-parts/two`);
      const { evaluate, until } = page;
      await until(`document.readyState === "complete" && !!document.body.dataset.fxRan`);
      await evaluate(
        `document.querySelector('.hw-catalog-bar a[href$="/box-parts/one/"]').click()`,
      );
      await until(`location.pathname.endsWith("/one/") && document.readyState === "complete"`);
      await new Promise((r) => setTimeout(r, 500));
      const after = await evaluate(
        `JSON.stringify([document.documentElement.dataset.fxHead, document.documentElement.dataset.hwScale, document.body.dataset.fxRan, !!document.querySelector("main .hw-catalog-bar"), document.body.dataset.fxBar])`,
      );
      expect(JSON.parse(String(after))).toEqual([
        "repository",
        "screen",
        "/dashboard/Parts/box-parts/one/",
        true,
        // The story's own inline script found the bar: it stood above the story from the start.
        "above",
      ]);
      // A key a story's own window listener takes stays with the story.
      await evaluate(
        `window.addEventListener("keydown", (e) => e.preventDefault(), { once: true }); document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))`,
      );
      await new Promise((r) => setTimeout(r, 500));
      expect(String(await evaluate("location.pathname"))).toEndWith("/one/");
      // The right arrow key steps to the next state.
      await evaluate(
        `document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))`,
      );
      await until(`location.pathname.endsWith("/two/") && document.readyState === "complete"`);
    } finally {
      page?.close();
      server.stop();
    }
  }, 90_000);

  // 40 tiles, each framing a page whose spec text sits above the element it marks as its preview.
  test("tile frames load after the first paint and near the view, and draw only the marked preview", async () => {
    const { renderCatalog } = await import("../catalog/render.ts");
    const shellCss = readFileSync(join(import.meta.dir, "..", "catalog", "catalog.css"), "utf8");
    // An even tile marks a full-width wrapper of its own ground around a smaller box, an odd one a
    // box with a ground of its own.
    const box =
      '<span class="box" style="display:inline-block;width:200px;height:100px;background:rgb(1, 2, 3)">x</span>';
    const story = (i: number) =>
      `<!doctype html><html style="background:#fff"><body><main><p class="spec">Spec text</p>${
        i % 2
          ? box.replace('class="box"', 'class="box" data-hw-preview')
          : `<div data-hw-preview><div>${box}</div></div>`
      }</main></body></html>`;
    const home = (path: string, srcdoc: boolean) =>
      `<!doctype html><html><head><style>${shellCss}</style></head><body>${renderCatalog({
        title: "t",
        lead: "l",
        provenance: "p",
        groups: [
          {
            name: "Parts",
            items: Array.from({ length: 40 }, (_, i) => ({
              name: `x${i}`,
              href: `/x${i}`,
              frame: `/${path}/${i}`,
              frameSrcdoc: srcdoc,
            })),
          },
        ],
      })}</body></html>`;
    const asked: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        asked.push(pathname);
        const html = { headers: { "Content-Type": "text/html" } };
        if (pathname === "/home") return new Response(home("story", false), html);
        if (pathname === "/inline") return new Response(home("deny", true), html);
        // A site that refuses to be framed, as one sending X-Frame-Options DENY.
        const deny = pathname.startsWith("/deny/");
        return new Response(story(Number(pathname.split("/").pop())), {
          headers: { ...html.headers, ...(deny && { "X-Frame-Options": "DENY" }) },
        });
      },
    });
    const page = await browse("about:blank", ["--window-size=1280,800"]);
    try {
      const { ws, send, evaluate, until } = page;
      const failed: string[] = [];
      ws.addEventListener("message", (event) => {
        const m = JSON.parse(String(event.data));
        if (m.method === "Network.loadingFailed") failed.push(m.params.errorText);
      });
      await send("Network.enable");
      const frames = (prefix: string) => asked.filter((p) => p.startsWith(prefix)).length;
      await send("Page.navigate", { url: `${server.url}home` });
      const fitted = `(() => { const f = document.querySelector(".hw-catalog-preview iframe"); return !!f.contentDocument?.querySelector("[data-hw-preview]") && f.style.transform.includes("scale"); })()`;
      await until(`document.readyState === "complete" && ${fitted}`);
      await new Promise((r) => setTimeout(r, 1000));
      // Only the tiles in or near the view load: four rows of three at 1280 x 800, not all 40.
      const near = frames("/story/");
      expect(near).toBeGreaterThan(0);
      expect(near).toBeLessThan(20);
      // No frame starts before the first paint.
      const [paint, firstFrame] = (await evaluate(
        `[performance.getEntriesByName("first-paint")[0]?.startTime, Math.min(...performance.getEntriesByType("resource").filter((e) => e.initiatorType === "iframe").map((e) => e.startTime))]`,
      )) as [number, number];
      expect(paint).toBeGreaterThan(0);
      expect(firstFrame).toBeGreaterThanOrEqual(paint);
      // The marked element alone shows, centred in its tile on what it paints, on the page's ground
      // around it, white, even where it has a ground of its own; the frame's canvas is cleared.
      const fit = (tile: number) =>
        evaluate(`(() => {
        const p = document.querySelectorAll(".hw-catalog-preview")[${tile}], f = p.firstElementChild, d = f.contentDocument;
        const r = d.querySelector(".box").getBoundingClientRect();
        const [tx, ty, s] = f.style.transform.match(/-?[\\d.]+/g).map(Number);
        return { dx: tx + (r.left + r.width / 2) * s - p.clientWidth / 2, dy: ty + (r.top + r.height / 2) * s - p.clientHeight / 2,
          spec: getComputedStyle(d.querySelector(".spec")).visibility, preview: getComputedStyle(d.querySelector("[data-hw-preview]")).visibility, ground: p.style.background, canvas: getComputedStyle(d.documentElement).backgroundColor };
      })()`) as Promise<Record<string, number | string>>;
      for (const tile of [0, 1]) {
        const at = await fit(tile);
        expect(Math.abs(at.dx as number)).toBeLessThan(1);
        expect(Math.abs(at.dy as number)).toBeLessThan(1);
        expect([at.spec, at.preview, at.ground, at.canvas]).toEqual([
          "hidden",
          "visible",
          "rgb(255, 255, 255)",
          "rgba(0, 0, 0, 0)",
        ]);
      }
      // Scrolled to the end, the last tile loads.
      await evaluate(`document.querySelector(".hw-catalog-grid li:last-child").scrollIntoView()`);
      await until(
        `!!document.querySelector(".hw-catalog-grid li:last-child iframe").contentDocument?.querySelector("[data-hw-preview]")`,
      );
      expect(asked).toContain("/story/39");
      expect(failed).toEqual([]);
      // `frameSrcdoc`: a page that refuses framing draws from its HTML; no frame load starts, so
      // none is cancelled.
      await send("Page.navigate", { url: `${server.url}inline` });
      await until(`document.readyState === "complete" && ${fitted}`);
      await new Promise((r) => setTimeout(r, 1000));
      expect(frames("/deny/")).toBeGreaterThan(0);
      expect(frames("/deny/")).toBeLessThan(20);
      expect(
        await evaluate(
          `[...document.querySelectorAll(".hw-catalog-preview iframe")].some((f) => f.hasAttribute("src"))`,
        ),
      ).toBe(false);
      expect(failed).toEqual([]);
      // Behind another tab the page is hidden and never paints: every tile loads at once.
      await send("Target.createTarget", { url: "about:blank" });
      expect(await evaluate("document.hidden")).toBe(true);
      const before = frames("/story/");
      await send("Page.navigate", { url: `${server.url}home` });
      await until(`document.readyState === "complete"`);
      for (const end = Date.now() + 10_000; frames("/story/") - before < 40 && Date.now() < end;)
        await new Promise((r) => setTimeout(r, 100));
      expect(frames("/story/") - before).toBe(40);
    } finally {
      page.close();
      void server.stop(true);
    }
  }, 60_000);

  test("a sized tile honours the marked preview, a mark may name a part, a clipped box fits as clipped", async () => {
    const { renderCatalog } = await import("../catalog/render.ts");
    const shellCss = readFileSync(join(import.meta.dir, "..", "catalog", "catalog.css"), "utf8");
    const part =
      '<span class="part" style="display:inline-block;width:200px;height:100px;background:rgb(1, 2, 3)">x</span><span class="other">y</span>';
    const wide = 'style="width:5000px;height:100px;background:rgb(1, 2, 3)"';
    const clipping = 'style="overflow:hidden;width:300px"';
    const stories: { html: string; size?: [number, number] }[] = [
      { html: `<div data-hw-preview>${part}</div>`, size: [1440, 900] },
      { html: `<div data-hw-preview=".part">${part}</div>`, size: [1440, 900] },
      { html: `<div data-hw-preview=".part">${part}</div>` },
      { html: `<div data-hw-preview ${clipping}><div><div ${wide}></div></div></div>` },
      { html: `<div data-hw-preview=".part" ${clipping}><div class="part" ${wide}></div></div>` },
      { html: `<div data-hw-preview="1">${part}</div>` },
      { html: `<div data-hw-preview=".none">${part}</div>` },
    ];
    const home = `<!doctype html><html><head><style>${shellCss}</style></head><body>${renderCatalog(
      {
        title: "t",
        lead: "l",
        provenance: "p",
        groups: [
          {
            name: "Parts",
            items: stories.map(({ size }, i) => ({
              name: `x${i}`,
              href: `/x${i}`,
              frame: `/story/${i}`,
              frameSize: size,
            })),
          },
        ],
      },
    )}</body></html>`;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        const body =
          pathname === "/home"
            ? home
            : `<!doctype html><html style="background:rgb(9, 9, 9)"><body><main><p class="spec">Spec text</p>${stories[Number(pathname.split("/").pop())]?.html}</main></body></html>`;
        return new Response(body, { headers: { "Content-Type": "text/html" } });
      },
    });
    const page = await browse(`${server.url}home`, ["--window-size=1280,1400"]);
    try {
      const { evaluate, until } = page;
      await until(
        `document.readyState === "complete" && document.querySelectorAll(".hw-catalog-preview iframe").length === ${stories.length} && [...document.querySelectorAll(".hw-catalog-preview iframe")].every((f) => f.contentDocument?.getElementById("hw-preview-only"))`,
      );
      const tile = (i: number) =>
        evaluate(`(() => {
        const p = document.querySelectorAll(".hw-catalog-preview")[${i}], f = p.firstElementChild, d = f.contentDocument;
        const shown = (s) => { const e = d.querySelector(s); return e && getComputedStyle(e).visibility; };
        return { w: f.style.width, h: f.style.height, t: f.style.transform, ground: p.style.background, canvas: getComputedStyle(d.documentElement).backgroundColor,
          spec: shown(".spec"), part: shown(".part"), other: shown(".other"), pw: p.clientWidth, ph: p.clientHeight };
      })()`) as Promise<Record<string, string | number>>;
      // A sized tile keeps its window and draws the mark alone, on the ground around it.
      const whole = await tile(0);
      expect([whole.w, whole.h]).toEqual(["1440px", "900px"]);
      expect(whole.t).toMatch(/^scale\([\d.]+\)$/);
      expect([whole.spec, whole.part, whole.other, whole.ground, whole.canvas]).toEqual([
        "hidden",
        "visible",
        "visible",
        "rgb(9, 9, 9)",
        "rgba(0, 0, 0, 0)",
      ]);
      // A mark holding a selector draws that part of it alone, sized or fitted.
      for (const i of [1, 2]) {
        const at = await tile(i);
        expect([at.spec, at.part, at.other]).toEqual(["hidden", "visible", "hidden"]);
      }
      // A value that is no selector, or selects nothing, draws the whole mark.
      for (const i of [5, 6]) {
        const at = await tile(i);
        expect([at.spec, at.part, at.other]).toEqual(["hidden", "visible", "visible"]);
      }
      // A clipping box bounds what the mark paints, inside it or around the part: 300 px, not 5000.
      for (const i of [3, 4]) {
        const clipped = await tile(i);
        const scale = Number(String(clipped.t).match(/scale\(([\d.]+)\)/)?.[1]);
        expect(scale).toBeCloseTo(
          Math.min(0.75, ((clipped.ph as number) - 16) / 100, ((clipped.pw as number) - 16) / 300),
          2,
        );
      }
    } finally {
      page.close();
      void server.stop(true);
    }
  }, 60_000);

  test("a group of markup draws it in place of tiles, without a count", async () => {
    const { renderCatalog } = await import("../catalog/render.ts");
    const html = renderCatalog({
      title: "t",
      lead: "l",
      provenance: "p",
      groups: [
        { name: "Parts", items: [{ name: "x", href: "/x" }] },
        { name: "Foundations", items: [], html: "<p>Tokens</p>" },
      ],
    });
    expect(html).toContain(
      '<li><a href="#foundations"><span>Foundations</span></a></li></ul></nav>',
    );
    expect(html).toContain(
      '</section><section class="hw-catalog-group" id="foundations"><h2>Foundations</h2><div class="hw-catalog-text"><p>Tokens</p></div></section></div>',
    );
  });

  test("a group of whitespace draws nothing; two groups under one anchor fail", async () => {
    const { renderCatalog } = await import("../catalog/render.ts");
    const base = { title: "t", lead: "l", provenance: "p" };
    const item = { name: "x", href: "/x" };
    const html = renderCatalog({
      ...base,
      groups: [
        { name: "Parts", items: [item] },
        { name: "Foundations", items: [], html: "\n  " },
      ],
    });
    expect(html).not.toContain("foundations");
    expect(() =>
      renderCatalog({
        ...base,
        groups: [
          { name: "Form Fields", items: [item] },
          { name: "form-fields", items: [item] },
        ],
      }),
    ).toThrow('catalog: the groups "Form Fields" and "form-fields" both draw as #form-fields');
  });

  test("the search finds a tile by its `search` words, which the tile does not show", async () => {
    const { renderCatalog } = await import("../catalog/render.ts");
    const html = renderCatalog({
      title: "t",
      lead: "l",
      provenance: "p",
      groups: [{ name: "Parts", items: [{ name: "Grid slide", href: "/x", search: "GridSlide" }] }],
    });
    expect(html).toContain('data-search="parts grid slide  gridslide"');
    expect(html).not.toContain(">GridSlide<");
  });

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
    scaffolding: { private: true, skip: { format: "fixture", lint: "fixture" } },
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
        scaffolding: { private: true, skip: { lint: "fixture" } },
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

  test("a missing prettier or eslint is refused, declared or not, unless the gate skips it", () => {
    const staged = (manifest: object, prettier = false) => {
      const dir = repo({ "package.json": JSON.stringify(manifest) });
      if (prettier) {
        write(dir, { "node_modules/.bin/prettier": "#!/bin/sh\nexit 0\n" });
        chmodSync(join(dir, "node_modules/.bin/prettier"), 0o755);
      }
      write(dir, { "a.ts": "export {};\n" });
      sh(dir, ["add", "a.ts"]);
      return run(dir, "check-staged");
    };
    const declared = staged({ devDependencies: { prettier: "3", eslint: "10" } });
    expect(declared.code).toBe(1);
    expect(declared.out).toContain("prettier not installed");
    const undeclared = staged({});
    expect(undeclared.code).toBe(1);
    expect(undeclared.out).toContain("prettier not installed");
    const lintMissing = staged({ scaffolding: { skip: { format: "none" } } });
    expect(lintMissing.code).toBe(1);
    expect(lintMissing.out).toContain("eslint not installed");
    expect(staged({ scaffolding: { skip: { format: "", lint: "none" } } }).out).toContain(
      "prettier not installed",
    );
    for (const format of [false, {}])
      expect(staged({ scaffolding: { skip: { format, lint: "none" } } }).out).toContain(
        "prettier not installed",
      );
    expect(staged({ scaffolding: { skip: { format: "none", lint: "none" } } }).code).toBe(0);
    const prettierOnly = staged({ scaffolding: { skip: { lint: "none" } } }, true);
    expect(prettierOnly.out).not.toContain("not installed");
    expect(prettierOnly.code).toBe(0);
  }, 20_000);

  test("staged CSS and Astro files run stylelint with the repository's config, unless skip.styles", () => {
    const stylelint = join(import.meta.dir, "..", "node_modules/stylelint/bin/stylelint.mjs");
    const html = join(import.meta.dir, "..", "node_modules/postcss-html/lib/index.js");
    const skip = { format: "none", lint: "none" };
    const staged = (files: Record<string, string>, styles?: unknown, installed = true) => {
      const dir = repo({
        "package.json": JSON.stringify({
          type: "module",
          scaffolding: { skip: { ...skip, styles } },
        }),
        "stylelint.config.js": `export default { overrides: [{ files: ["**/*.astro"], customSyntax: "${html}" }], rules: { "color-no-invalid-hex": true } };\n`,
        "nested/.stylelintrc.json": "{}",
      });
      if (installed) {
        mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
        symlinkSync(stylelint, join(dir, "node_modules/.bin/stylelint"));
      }
      write(dir, files);
      sh(dir, ["add", ...Object.keys(files)]);
      return { dir, ...run(dir, "check-staged") };
    };
    const bad = "a { color: #ggg; }\n";
    expect(staged({ "a.css": bad }, undefined, false).out).toContain("stylelint not installed");
    expect(staged({ "a.ts": "export {};\n", ".x/a.css": bad }, undefined, false).code).toBe(0);
    expect(staged({ "a.css": bad }, "none", false).code).toBe(0);
    expect(staged({ "a.css": bad }, " ", false).out).toContain("stylelint not installed");
    // nested/c.css: a nested config would let it pass, but the repository's own governs, as in the gate.
    const red = staged({
      "a.css": bad,
      "a.ts": "#ggg\n",
      "B.astro": `<p>a</p>\n<style>\n  ${bad}</style>\n`,
      "nested/c.css": bad,
      ".storybook/d.css": bad,
    });
    expect(red.out).toContain("a.css: line 1, col 12, error - Invalid hex color");
    expect(red.out).toContain("B.astro: line 3, col 14, error - Invalid hex color");
    expect(red.out).toContain("nested/c.css: line 1, col 12");
    expect(red.out).not.toContain("a.ts:");
    expect(red.out).not.toContain("d.css");
    expect(red.code).toBe(1);
    const ok = staged({ "a.css": "a { color: #fff; }\n" });
    expect(ok.code).toBe(0);
    write(ok.dir, { "a.css": bad });
    sh(ok.dir, ["add", "a.css"]);
    write(ok.dir, { "a.css": "a { color: #000; }\n" });
    const partial = run(ok.dir, "check-staged");
    expect(partial.out).toContain("[check:staged] stylelint: a.css as staged");
    expect(partial.code).toBe(1);
  }, 20_000);

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

  // Installed as a consumer installs it, beside the consumer's own `typescript`, so a run that
  // imported the consumer's TypeScript would crash on 7, which ships no compiler API.
  test.each([
    ["6", "@typescript/old"],
    ["7", "@typescript/native"],
  ])("runs beside a consumer's TypeScript %s", (_, consumerTs) => {
    const dir = repo({ ...code, "package.json": "{}" });
    const own = join(import.meta.dir, "..");
    const pkg = join(dir, "node_modules/@hackersandwizards/scaffolding");
    for (const path of ["package.json", "bin/check-unique-names.ts", "lib/repo.ts"])
      write(pkg, { [path]: readFileSync(join(own, path), "utf8") });
    symlinkSync(join(own, "node_modules", consumerTs), join(dir, "node_modules/typescript"));
    symlinkSync(join(own, "node_modules/@typescript"), join(dir, "node_modules/@typescript"));
    const r = spawnSync(process.execPath, [join(pkg, "bin/check-unique-names.ts")], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(`${r.stdout}${r.stderr}`).toContain("twice is defined 2 times");
    expect(r.status).toBe(1);
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
    "<p>",
    "  sold by",
    "  <small>x</small>",
    "</p>",
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
      ["44", "small"],
    ]);
    const empty = run(
      repo({ "src/B.astro": "---\n---\n<code>x</code>\n", "package.json": "{}" }),
      "check-spaces",
    );
    expect(empty.code).toBe(0);
  });

  test("passes where every Astro config turns compressHTML off; one on, or commented out, reads", () => {
    const off = "export default {\n  compressHTML: false,\n};\n";
    const code = (configs: Record<string, string>) =>
      run(repo({ "src/A.astro": page, "package.json": "{}", ...configs }), "check-spaces").code;
    expect(code({ "astro.config.mjs": off, "catalog/astro.config.ts": off })).toBe(0);
    expect(
      code({ "astro.config.mjs": off, "catalog/astro.config.ts": "export default {};\n" }),
    ).toBe(1);
    expect(code({ "astro.config.mts": "// compressHTML: false\nexport default {};\n" })).toBe(1);
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

describe("check-history", () => {
  const shipped = (files: Record<string, string>, scaffolding: object = {}) =>
    repo({
      "package.json": JSON.stringify({
        name: "fx",
        version: "1.0.0",
        files: ["src", ".githooks"],
        scaffolding,
      }),
      ...files,
    });

  test("flags history in the comments of shipped files only", () => {
    const r = run(
      shipped({
        "src/a.css":
          "a { b: c } /* blind panel 2026-11-01 */\n#id { x: 'https://x.y/2026-11-01' }\n",
        "src/b.ts": "const a = 'Benedikt'; // see new-claim for the rest\n",
        "src/c.html": "<!-- OS-1 -->\n",
        ".githooks/pre-commit": "# decision label-system, 06.11.\nrun\n",
        "src/clean.ts":
          "// how to use it, why it is so: UTF-8, SHA-256\nconst at = '2026-11-01';\n",
        "docs/agent-work/items/new-claim.md": "x\n",
        "other/d.css": "/* blind panel 2026-11-01 */\n",
      }),
      "check-history",
    );
    expect(r.code).toBe(1);
    expect(lines(r.out, "history").map((l) => l.replace(/ \(.*/, ""))).toEqual([
      "[history] .githooks/pre-commit: decision id",
      "[history] .githooks/pre-commit: date",
      "[history] src/a.css: review score",
      "[history] src/a.css: date",
      "[history] src/b.ts: item id",
      "[history] src/c.html: item id",
    ]);
  });

  test("reads every hit, an item slug only whole, and nothing where nothing ships", () => {
    const r = run(
      shipped({
        "src/a.ts": "/** As written, 31.10.2026; see new-claim-flow (blind panel 01.11.). */\n",
        "docs/agent-work/items/new-claim.md": "x\n",
      }),
      "check-history",
    );
    expect(lines(r.out, "history").map((l) => l.replace(/ \(.*/, ""))).toEqual([
      "[history] src/a.ts: review score",
      "[history] src/a.ts: date",
      "[history] src/a.ts: date",
    ]);
    const surface = (pkg: object) =>
      run(
        repo({ "package.json": JSON.stringify(pkg), "a.ts": "// 2026-11-01\n" }),
        "check-history",
      );
    expect(surface({ name: "fx", private: true }).code).toBe(0);
    const noVersion = surface({ name: "fx", files: ["a.ts"] });
    expect(noVersion.code).toBe(1);
    expect(noVersion.out).toContain("bun pm pack listed no files");
  });

  test("reads a block comment touching what precedes it, and a capitalised item", () => {
    const r = run(
      shipped({
        "src/a.css": "a{b:c;}/* (Benedikt, 01.11.) */\n",
        "src/b.css": 'a{content:"x"}/* OS-1 */\n',
        "src/c.css": "a{b:red/* ok *//* blind panel */}\n",
        "src/d.ts": "// Item new-claim-flow\n",
        "src/e.css": 'a{content:"\\""}/* /* don\'t *//* OS-2 */\n',
        "src/f.html": "<style>/* OS-3 */</style>\n",
      }),
      "check-history",
    );
    expect(lines(r.out, "history").map((l) => l.replace(/ \(.*/, ""))).toEqual([
      "[history] src/a.css: date",
      "[history] src/a.css: person",
      "[history] src/b.css: item id",
      "[history] src/c.css: review score",
      "[history] src/d.ts: item id",
      "[history] src/e.css: item id",
      "[history] src/f.html: item id",
    ]);
  });

  test("reads a comment's lines joined, whatever marks them", () => {
    const r = run(
      shipped({
        "src/a.ts": "// the flow (decision\n// merge-comparison, as drawn)\nconst a = 1;\n",
        "src/b.ts": "/**\n * the flow (decision\n * merge-comparison)\n */\n",
        "src/c.ts": "const a = 1; // the flow (blind\n             // panel)\n",
        ".githooks/pre-commit": "# the flow (decision\n# merge-comparison)\nrun\n",
        "src/d.ts": "// the flow (decision\r\n// merge-comparison)\r\n",
        "src/e.html": "<!-- the flow (blind\n     panel) -->\n",
      }),
      "check-history",
    );
    expect(lines(r.out, "history").map((l) => l.replace(/ \(.*/, ""))).toEqual([
      "[history] .githooks/pre-commit: decision id",
      "[history] src/a.ts: decision id",
      "[history] src/b.ts: decision id",
      "[history] src/c.ts: review score",
      "[history] src/d.ts: decision id",
      "[history] src/e.html: review score",
    ]);
  });

  test("keeps comments apart that code or an empty line separates", () => {
    const r = run(
      shipped({
        "src/a.ts": "// the decision\nconst a = 1;\n// merge-comparison is a name\n",
        "src/b.ts": "// the decision\n\n// merge-comparison is a name\n",
        "src/c.ts": "const a = 1; // the decision\nconst b = 2; // merge-comparison\n",
        ".githooks/pre-commit": "# the decision\n\n# merge-comparison is a name\nrun\n",
        "src/d.ts": "// the decision\n//\n// merge-comparison is a name\n",
        "src/e.ts": "/**\n * the decision\n *\n * merge-comparison is a name\n */\n",
      }),
      "check-history",
    );
    expect(lines(r.out, "history")).toEqual([]);
    expect(r.code).toBe(0);
  });

  test("flags a score comparison and leaves version numbers alone", () => {
    const r = run(
      shipped({
        "src/a.ts": "// the flow, 7.94 against\n// 7.29 for the rest.\n",
        "src/b.ts": "// the flow, 8.4 vs 7.9\n",
        "src/c.ts": "// the flow, 8.00 against 7.00.\n",
        "src/d.ts": "// the gap (7.00 in the same panel)\n",
        "src/e.ts": "// both gaps, 7.75 of 10 against 5.75\n",
        "src/clean.ts": [
          "// 2.11.1 against 2.11.0 changed the flag",
          "// v1.2 vs v1.3 changed the flag",
          "// Node 18.2 vs 20.1 changed the flag",
          "// Python 3.11 vs 3.12 changed the flag",
          "// HTTP/1.1 vs 2.0 changed the flag",
          "// macOS 10.14 vs 10.15 changed the flag",
          "// a value 10.5 vs 9.2",
          "// 1.10.1 vs 1.9 changed the flag",
          "// a side panel, 7.5 in the panel's width",
          "",
        ].join("\n"),
      }),
      "check-history",
    );
    expect(lines(r.out, "history").map((l) => l.replace(/ \(.*/, ""))).toEqual([
      "[history] src/a.ts: review score",
      "[history] src/b.ts: review score",
      "[history] src/c.ts: review score",
      "[history] src/d.ts: review score",
      "[history] src/e.ts: review score",
    ]);
  });

  test("takes a one-digit month only before a year, a bracket or a comma", () => {
    const r = run(
      shipped({
        "src/a.ts": "// the last line (the panel 1.1.)\n",
        "src/b.ts": "// as written, 5.3.2026\n",
        "src/c.ts": "// the panel 1.1., the rest\n",
        "src/clean.ts": [
          "// a gain of only 4.7.",
          "// a gain of only 4.7. The rest stays.",
          "// (since 2.11.3.)",
          "// 1.2.3, 2.11.3 and 1.5.3.2",
          "// 1.1.20261",
          "",
        ].join("\n"),
      }),
      "check-history",
    );
    expect(lines(r.out, "history").map((l) => l.replace(/ \(.*/, ""))).toEqual([
      "[history] src/a.ts: date",
      "[history] src/b.ts: date",
      "[history] src/c.ts: date",
    ]);
  });

  test("a block comment opens neither inside a string nor inside url()", () => {
    const end = "const b = 'x'; // */\n";
    const r = run(
      shipped({
        "src/a.ts": `const a = ["src/*.ts", 'lib/*', \`x/*\`];\nconst d = 'OS-1 2026-11-01';\n${end}`,
        "src/b.css": "a{b:url(/*.png)}\nc{d:url(x/*.png)}\ne{content:'OS-1'}\nf{g:h} /* */\n",
        "src/c.ts": "const a = /\\/*x/;\nconst d = 'OS-1';\n" + end,
        "src/d.ts": `const a = /[/*]/;\nconst d = 'OS-1';\n${end}`,
        "src/e.ts": `const a = \`\n  src/*.ts\n\`;\nconst d = 'OS-1';\n${end}`,
        "src/f.css": "a{b:URL(/*.png)}\ne{content:'OS-1'}\nf{g:h} /* */\n",
        "src/g.md": "Reads docs/*.md, OS-1 and\n**/*.ts\n",
      }),
      "check-history",
    );
    expect(lines(r.out, "history")).toEqual([]);
    expect(r.code).toBe(0);
  });

  test("an allow entry keeps a case; a stale one is red", () => {
    const allowed = (text: string) =>
      shipped(
        { "src/a.ts": "/** A date as a reader writes it, 31.10.2026. */\n" },
        { allow: [{ check: "history", path: "src/a.ts", text, reason: "format example" }] },
      );
    expect(run(allowed("31.10.2026"), "check-history").code).toBe(0);
    expect(run(allowed("nothing"), "check-history").out).toContain("allow entry matches nothing");
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
    for (const gsap of [
      { license: pinned.license },
      { ...pinned, reason: {} },
      { ...pinned, license: true },
    ]) {
      const reasonless = keep({ gsap });
      expect(reasonless.code).toBe(1);
      expect(reasonless.out).toContain("needs a license string and a reason");
    }
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

  test("a lock entry bun skips passes when nothing installed needs it, and is red when it is", () => {
    // Tailwind's oxide-wasm32-wasi shape: "a" bundles its own "b", and the top-level "b" serves
    // only "c", which this platform leaves out.
    const mit = { version: "1.0.0", license: "MIT" };
    const dir = repo({
      "src/a/package.json": JSON.stringify({
        name: "a",
        ...mit,
        dependencies: { b: "1.0.0" },
        bundledDependencies: ["b"],
      }),
      "src/a/node_modules/b/package.json": JSON.stringify({ name: "b", ...mit }),
      "src/b/package.json": JSON.stringify({ name: "b", ...mit }),
      "src/c/package.json": JSON.stringify({ name: "c", ...mit, dependencies: { b: "1.0.0" } }),
      "package.json": JSON.stringify({
        name: "fx",
        dependencies: { a: "file:./a-1.0.0.tgz" },
        optionalDependencies: { c: "file:./c-1.0.0.tgz" },
        overrides: { b: "file:./b-1.0.0.tgz" },
      }),
    });
    for (const p of ["a", "b", "c"])
      spawnSync(process.execPath, ["pm", "pack", "--destination", dir], {
        cwd: join(dir, "src", p),
      });
    const bun = (args: string[]) =>
      expect(spawnSync(process.execPath, args, { cwd: dir }).status).toBe(0);
    bun(["install"]);
    const lock = join(dir, "bun.lock");
    const pinned = readFileSync(lock, "utf8").replace(
      /("c": \["c@[^"]*", \{ "dependencies": \{ "b": "1\.0\.0" \})/,
      '$1, "os": "none"',
    );
    expect(pinned).toContain('"os": "none"');
    writeFileSync(lock, pinned);
    rmSync(join(dir, "node_modules"), { recursive: true });
    bun(["install", "--frozen-lockfile"]);
    expect(existsSync(join(dir, "node_modules/b"))).toBe(false);
    expect(run(dir, "check-licenses")).toEqual({ code: 0, out: "" });
    rmSync(join(dir, "node_modules/a/node_modules/b"), { recursive: true });
    const unbundled = run(dir, "check-licenses");
    expect(unbundled.code).toBe(1);
    expect(unbundled.out).toContain("a/b");
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

  for (const stopped of [true, false])
    test(`${stopped ? "stop()" : "SIGKILL to the process that served"} ends a server behind a wrapper`, async () => {
      const app = join(temp(), "app.ts");
      writeFileSync(
        app,
        "Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => new Response(String(process.pid)) });\n",
      );
      // `; :` keeps sh as the parent, so the server is a grandchild.
      const wrapped = JSON.stringify(["sh", "-c", `${process.execPath} ${app}; :`]);
      const parent = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const s = await (await import(${JSON.stringify(join(import.meta.dir, "..", "lib", "serve.ts"))})).serve(${wrapped}); console.log(await (await fetch(s.url)).text()); ${stopped ? "s.stop();" : "await new Promise(() => {});"}`,
        ],
        { stdout: "pipe" },
      );
      try {
        let line = "";
        const decoder = new TextDecoder();
        for await (const chunk of parent.stdout) {
          line += decoder.decode(chunk);
          if (line.includes("\n")) break;
        }
        const pid = Number(line);
        expect(pid).toBeGreaterThan(0);
        if (!stopped) parent.kill("SIGKILL");
        const alive = () => {
          try {
            return process.kill(pid, 0);
          } catch {
            return false;
          }
        };
        for (const end = Date.now() + 5_000; alive() && Date.now() < end;) await Bun.sleep(100);
        expect(alive()).toBe(false);
      } finally {
        parent.kill("SIGKILL");
      }
    }, 15_000);
});
