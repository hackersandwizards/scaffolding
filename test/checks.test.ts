import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

  test("checks only staged files with --staged", () => {
    const dir = repo({ "package.json": "{}", "src/old.ts": 'import "../../x";\n' });
    write(dir, { "src/new.ts": 'import "../../y";\n' });
    sh(dir, ["add", "src/new.ts"]);
    const found = lines(run(dir, "check-coupling", ["--staged"]).out, "check-coupling");
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("src/new.ts");
  });

  test("an allow entry needs a reason and must still match", () => {
    const allow = (entries: object[]) =>
      repo({
        "package.json": JSON.stringify({ scaffolding: { allow: entries } }),
        "src/a.ts": 'import "../../x";\n',
      });
    const reasoned = { check: "coupling", path: "src/*.ts", reason: "test" };
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

describe("scaffold and check-structure", () => {
  const parent = temp();
  const dir = join(parent, "demo");
  const made = run(parent, "scaffold", ["demo"]);
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

  test("a repository without package.json is reported, not a crash", () => {
    const r = run(repo({ "a.md": "a\n" }), "check-structure");
    expect(r.code).toBe(1);
    expect(r.out).toContain("[check-structure] package.json: missing");
  });

  test("a scaffolded repository passes check-coupling", () => {
    expect(run(dir, "check-coupling").code).toBe(0);
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

  test("only added lines count", () => {
    const dir = repo({ "package.json": "{}", "a.md": "Acme Widgets GmbH\n" });
    write(dir, { "a.md": "Acme Widgets GmbH\nmore\n" });
    sh(dir, ["add", "a.md"]);
    expect(run(dir, "check-confidential", ["--staged"], env).code).toBe(0);
  });

  test("the commit message is checked", () => {
    const dir = repo({ "package.json": "{}" });
    const msg = join(dir, "MSG");
    writeFileSync(msg, "fix: for Acme Widgets\n# Jane Q Doe in a comment line is ignored\n");
    expect(run(dir, "check-confidential", ["--message-file", msg], env).out).toContain(
      "(Acme Widgets)",
    );
  });

  test("an image under docs/tracking passes once read clean; one that cannot be read goes red", () => {
    // A decodable 1x1 PNG: OCR reads it and finds no text.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      "base64",
    );
    const dir = repo({ "package.json": "{}" });
    mkdirSync(join(dir, "docs/tracking/review"), { recursive: true });
    writeFileSync(join(dir, "docs/tracking/review/shot.png"), png);
    sh(dir, ["add", "docs/tracking/review/shot.png"]);
    expect(run(dir, "check-confidential", ["--staged"], { ...env, CI: "" }).code).toBe(0);
    write(dir, { "docs/tracking/review/broken.png": "not really a png" });
    sh(dir, ["add", "docs/tracking/review/broken.png"]);
    const r = run(dir, "check-confidential", ["--staged"], { ...env, CI: "" });
    expect(r.out).toContain("docs/tracking/review/broken.png: image not read");
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
    const push = (sha: string) =>
      spawnSync(process.execPath, [bin("check-confidential"), "prepush", "origin", remote], {
        cwd: dir,
        input: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
        encoding: "utf8",
      });
    const refused = push(purged);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("purged from this repository's history");
    const clean = sh(dir, ["rev-parse", "HEAD~1"]).stdout.toString().trim();
    expect(push(clean).status).toBe(0);
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

  /** A fresh checkout: a gh that grants or denies, and a cached copy of a given age. */
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
    write(m.dir, { "docs/tracking/shot.png": "x" });
    sh(m.dir, ["add", "docs/tracking/shot.png"]);
    expect(m.check({ CI: "true" }).out).toContain("image or PDF in docs/tracking not read");
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
  const all = { format: "t", lint: "t", typecheck: "t", structure: "t", coupling: "t" };
  const skip = { ...all, "unique-names": "t", confidential: "t", test: "t" };

  test("runs the repository's steps in order and passes", () => {
    const dir = gate({ skip, check: ["mine", ["true", "true"]] }, { mine: "echo ran-mine" });
    const r = run(dir, "scaffolding", ["check"], { CHECK_LOCK: join(dir, ".lock") });
    expect(r.code).toBe(0);
    expect(r.out).toContain("ran-mine");
    expect(r.out).toContain("passed");
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
