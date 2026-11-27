import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  cssImportHits,
  cssImportViolation,
  dependencyPinHits,
  dependencyPinViolation,
  installedPackageViolation,
  installedPathHits,
  isAllowedOxlintExtends,
  isInsideOpenQuote,
  PackageRegistry,
  stripCouplingComments,
  stripUnquotedComments,
} from "../lib/coupling-checks.ts";
import { defined } from "../lib/defined.js";
import { commentSyntax } from "../lib/repo.ts";
import oxlintTemplate from "../template/.oxlintrc.json";

const MODULES = "node_modules";
const SCOPE = "@hackersandwizards";
const pkgPath = (pkg: string, rest: string) => `${MODULES}/${SCOPE}/${pkg}/${rest}`;

function withTempPackages(
  manifests: Record<string, Record<string, unknown>>,
  run: (root: string) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "coupling-checks-test-"));
  try {
    for (const [name, pkg] of Object.entries(manifests)) {
      const dir = join(root, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.each([
  { name: "@hackersandwizards/brand", expected: true },
  { name: "custom-engine", expected: true },
  { name: "lodash", expected: false },
])("PackageRegistry.isOurs classifies $name", ({ name, expected }) => {
  const registry = new PackageRegistry("/nonexistent", {
    dependencies: { "custom-engine": "git+https://github.com/hackersandwizards/custom#v1.0.0" },
  });
  expect(registry.isOurs(name)).toBe(expected);
});

test("PackageRegistry.manifest caches reads and publishes distinguishes disk vs export subpaths", () => {
  withTempPackages(
    {
      "@hackersandwizards/brand": {
        version: "2.0.0",
        exports: { "./tokens.css": "./dist/tokens.css" },
      },
    },
    (root) => {
      const registry = new PackageRegistry(root, {}, "@hackersandwizards/app");
      expect(registry.manifest("missing-pkg")).toBeNull();
      const first = registry.manifest("@hackersandwizards/brand");
      rmSync(join(root, pkgPath("brand", "package.json")));
      expect(registry.manifest("@hackersandwizards/brand")).toBe(first);
      expect(registry.publishes("@hackersandwizards/brand", "tokens.css", false)).toBe(true);
      expect(registry.publishes("@hackersandwizards/brand", "dist/tokens.css", true)).toBe(true);
      expect(registry.publishes("@hackersandwizards/brand", "private.css", false)).toBe(false);
    },
  );
});

test.each([
  { text: 'const s = "a // b";', at: 13, kept: "", expected: true },
  { text: "const s = 1; // b", at: 13, kept: "", expected: false },
  { text: '"unclosed\nconst a = 1; // b', at: 23, kept: "", expected: false },
  { text: "first\n'open // c", at: 12, kept: "", expected: true },
  { text: "const s = 'x'; // y", at: 15, kept: "", expected: false },
])("isInsideOpenQuote detects open quote at $at in $text", ({ text, at, kept, expected }) => {
  expect(isInsideOpenQuote(text, at, kept)).toBe(expected);
});

test.each([
  {
    label: "strips line comments outside strings",
    text: "const a = 1; // comment\nconst b = 2;",
    path: "a.ts",
    expected: "const a = 1; \nconst b = 2;",
  },
  {
    label: "keeps // inside an unclosed template quote",
    text: "`prefix ${x} // inside`",
    path: "a.ts",
    expected: "`prefix ${x} // inside`",
  },
  {
    label: "strips block comments even after odd quotes on same line",
    text: 'const s = "a"; /* comment */',
    path: "a.ts",
    expected: 'const s = "a"; ',
  },
])("stripUnquotedComments $label", ({ text, path, expected }) => {
  expect(stripUnquotedComments(text, commentSyntax(path))).toBe(expected);
});

test.each([
  {
    label: "strips Python triple-quoted docstrings",
    path: "script.py",
    text: `"""${pkgPath("brand", "x")}"""\nvalue = 1 # tail`,
    expected: "\nvalue = 1 ",
  },
  {
    label: "keeps non-Python triple quotes intact",
    path: "app.ts",
    text: 'const x = """keep"""; // drop',
    expected: 'const x = """keep"""; ',
  },
])("stripCouplingComments $label", ({ path, text, expected }) => {
  expect(stripCouplingComments(path, text)).toBe(expected);
});

test.each([
  {
    path: ".oxlintrc.json",
    line: `  "extends": ${JSON.stringify(oxlintTemplate.extends)},`,
    expected: true,
  },
  {
    path: ".oxlintrc.json",
    line: '  "extends": ["./other.json"],',
    expected: false,
  },
  {
    path: "other.json",
    line: `  "extends": ${JSON.stringify(oxlintTemplate.extends)},`,
    expected: false,
  },
])("isAllowedOxlintExtends checks $path", ({ path, line, expected }) => {
  expect(isAllowedOxlintExtends(path, line)).toBe(expected);
});

test("installedPackageViolation distinguishes code paths from stylesheet disk paths", () => {
  withTempPackages(
    {
      "@hackersandwizards/brand": {
        exports: { "./theme.json": "./dist/theme.json" },
      },
    },
    (root) => {
      const registry = new PackageRegistry(root, {});
      const cssMatch = defined(
        /node_modules\/(@[\w.-]+\/[\w.-]+)(\/\S+)?/.exec(pkgPath("brand", "dist/a.css")),
        "css package path match",
      );
      const exportedMatch = defined(
        /node_modules\/(@[\w.-]+\/[\w.-]+)(\/\S+)?/.exec(pkgPath("brand", "dist/theme.json")),
        "exported package path match",
      );
      const privateMatch = defined(
        /node_modules\/(@[\w.-]+\/[\w.-]+)(\/\S+)?/.exec(pkgPath("brand", "dist/secret.json")),
        "private package path match",
      );
      expect(installedPackageViolation("src/app.css", cssMatch, registry)).toBeUndefined();
      expect(installedPackageViolation("src/app.css", exportedMatch, registry)).toBeUndefined();
      expect(installedPackageViolation("src/app.css", privateMatch, registry)).toContain(
        "a stylesheet names a disk path only to a file @hackersandwizards/brand exports",
      );
      expect(installedPackageViolation("src/app.ts", exportedMatch, registry)).toContain(
        "hard-coded path into an installed package",
      );
    },
  );
});

test.each([
  {
    label: "skips text without node_modules",
    path: "src/app.ts",
    text: 'import x from "@hackersandwizards/brand";',
    expectedCount: 0,
  },
  {
    label: "skips Tailwind @source references",
    path: "src/app.css",
    text: `@source "../${MODULES}/${SCOPE}/brand";`,
    expectedCount: 0,
  },
  {
    label: "skips own package name",
    path: "src/app.ts",
    text: `const p = "${pkgPath("self", "a.js")}";`,
    expectedCount: 0,
  },
  {
    label: "flags company package disk path in code",
    path: "src/app.ts",
    text: `const p = "${pkgPath("brand", "dist/a.js")}";`,
    expectedCount: 1,
  },
])("installedPathHits $label", ({ path, text, expectedCount }) => {
  const registry = new PackageRegistry("/nonexistent", {}, "@hackersandwizards/self");
  expect(installedPathHits(path, text, registry)).toHaveLength(expectedCount);
});

test.each([
  {
    label: "exported brand CSS passes",
    path: "src/app.ts",
    spec: { name: "@hackersandwizards/brand", raw: "base.css", disk: false },
  },
  {
    label: "scaffolding shell CSS under catalog/ passes",
    path: "catalog/index.ts",
    spec: { name: "@hackersandwizards/scaffolding", raw: "shell.css", disk: false },
  },
])("cssImportViolation allows $label", ({ path, spec }) => {
  withTempPackages(
    {
      "@hackersandwizards/brand": { exports: { "./base.css": "./dist/base.css" } },
    },
    (root) => {
      const registry = new PackageRegistry(root, {});
      expect(cssImportViolation(path, spec, registry)).toBeUndefined();
    },
  );
});

test.each([
  {
    label: "unexported brand CSS fails",
    path: "src/app.ts",
    spec: { name: "@hackersandwizards/brand", raw: "hidden.css", disk: false },
    expectedFragment: "not in the exports of @hackersandwizards/brand",
  },
  {
    label: "scaffolding shell CSS outside catalog/ fails",
    path: "src/page.ts",
    spec: { name: "@hackersandwizards/scaffolding", raw: "shell.css", disk: false },
    expectedFragment: "the catalog shell's styles load only under catalog/",
  },
  {
    label: "undeclared engine CSS fails",
    path: "src/page.ts",
    spec: { name: "@hackersandwizards/slides", raw: "other.css", disk: false },
    expectedFragment: "styles come from brand's exports",
  },
  {
    label: "declared but unexported engine CSS fails",
    path: "src/page.ts",
    spec: { name: "@hackersandwizards/slides", raw: "deck.css", disk: false },
    expectedFragment: "not in the exports of @hackersandwizards/slides",
  },
])("cssImportViolation rejects $label", ({ path, spec, expectedFragment }) => {
  withTempPackages(
    {
      "@hackersandwizards/brand": { exports: { "./base.css": "./dist/base.css" } },
      "@hackersandwizards/slides": {
        exports: { "./public.css": "./dist/public.css" },
        scaffolding: { styles: ["deck.css"] },
      },
    },
    (root) => {
      const registry = new PackageRegistry(root, {});
      expect(cssImportViolation(path, spec, registry)).toContain(expectedFragment);
    },
  );
});

test("cssImportHits ignores disk paths outside stylesheets and own package imports", () => {
  withTempPackages(
    {
      "@hackersandwizards/brand": { exports: { "./base.css": "./dist/base.css" } },
    },
    (root) => {
      const registry = new PackageRegistry(root, {}, "@hackersandwizards/self");
      const tsHits = cssImportHits(
        "src/app.ts",
        `import "${pkgPath("brand", "hidden.css")}"; import "${SCOPE}/self/a.css";`,
        registry,
      );
      const cssHits = cssImportHits(
        "src/app.css",
        `@import "${pkgPath("brand", "hidden.css")}";`,
        registry,
      );
      expect(tsHits).toEqual([]);
      expect(cssHits).toHaveLength(1);
    },
  );
});

test.each([
  {
    label: "pinned peerDependency skips installed version check",
    field: "peerDependencies",
    entry: { name: "engine", spec: "git+https://github.com/hackersandwizards/engine.git#v2.0.0" },
  },
  {
    label: "matching installed git dependency",
    field: "dependencies",
    entry: { name: "engine", spec: "git+https://github.com/hackersandwizards/engine.git#v1.0.0" },
  },
])("dependencyPinViolation allows $label", ({ field, entry }) => {
  withTempPackages({ engine: { version: "1.0.0" } }, (root) => {
    const registry = new PackageRegistry(root, {});
    expect(dependencyPinViolation(field, entry, registry)).toBeUndefined();
  });
});

test.each([
  {
    label: "local file dependency",
    field: "dependencies",
    entry: { name: "local", spec: "file:../local" },
    expectedFragment: "local path dependency",
  },
  {
    label: "unpinned git dependency",
    field: "dependencies",
    entry: { name: "engine", spec: "git+https://github.com/hackersandwizards/engine.git" },
    expectedFragment: "Git dependency not pinned to a version tag",
  },
  {
    label: "stale installed git dependency",
    field: "dependencies",
    entry: { name: "engine", spec: "git+https://github.com/hackersandwizards/engine.git#v2.0.0" },
    expectedFragment: "node_modules holds 1.0.0, not the pinned 2.0.0",
  },
])("dependencyPinViolation rejects $label", ({ field, entry, expectedFragment }) => {
  withTempPackages({ engine: { version: "1.0.0" } }, (root) => {
    const registry = new PackageRegistry(root, {});
    expect(dependencyPinViolation(field, entry, registry)).toContain(expectedFragment);
  });
});

test("dependencyPinHits aggregates findings across dependency fields in order", () => {
  withTempPackages({}, (root) => {
    const pkg = {
      dependencies: { a: "link:../a" },
      devDependencies: { b: "git+https://github.com/org/b.git" },
    };
    const registry = new PackageRegistry(root, pkg);
    const hits = dependencyPinHits(pkg, registry);
    expect(hits.map((h) => h.text)).toEqual(["a@link:../a", "b@git+https://github.com/org/b.git"]);
  });
});
