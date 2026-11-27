import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { lintOverlaps } from "../lib/lint-disjoint.ts";
import { testDirectory } from "./test-directory.ts";

const playwrightImports = 'import { test, expect } from "@playwright/test";\n\n';
const fixtureImports = 'import { test, expect } from "./fixture";\n\n';
const playwrightFixture =
  'import { test as base } from "@playwright/test"; export { expect } from "@playwright/test"; export const test = base.extend({});';
const cleanPlaywright =
  'test("shows the title", async ({ page }) => { await expect(page.locator("h1")).toBeVisible(); });';
const emptyCheck = 'test("runs the action", () => { console.log("action"); });';
const action = (body: string) => `test("checks the page", async ({ page }) => { ${body} });`;
const suite = (body: string) => `test.describe("feature", () => { ${body} });`;
const hook = 'test.beforeEach(async ({ page }) => { await page.goto("/"); });';
const depth = (count: number): string => (count ? suite(depth(count - 1)) : cleanPlaywright);

const violations: Record<string, string> = {
  "consistent-spacing-between-blocks": `${cleanPlaywright}\n${emptyCheck}`,
  "expect-expect": emptyCheck,
  "max-nested-describe": depth(6),
  "missing-playwright-await": action('expect(page.locator("h1")).toBeVisible();'),
  "no-conditional-expect": action("if (page) expect(1).toBe(1);"),
  "no-conditional-in-test": action("if (page) console.log(1);"),
  "no-duplicate-hooks": suite(`${hook}\n\n${hook}`),
  "no-duplicate-slow": action("test.slow(); test.slow();"),
  "no-element-handle": action('await page.$("h1");'),
  "no-eval": action('await page.$eval("h1", (element) => element.textContent);'),
  "no-focused-test": cleanPlaywright.replace("test(", "test.only("),
  "no-force-option": action('await page.locator("button").click({ force: true });'),
  "no-identical-title": `${cleanPlaywright}\n\n${cleanPlaywright}`,
  "no-nested-step": action(
    'await test.step("outer", async () => { await test.step("middle", async () => { await test.step("inner", async () => { expect(1).toBe(1); }); }); });',
  ),
  "no-networkidle": action('await page.waitForLoadState("networkidle");'),
  "no-page-pause": action("await page.pause();"),
  "no-skipped-test": cleanPlaywright.replace("test(", "test.skip("),
  "no-standalone-expect": "expect(1).toBe(1);",
  "no-unnecessary-assertions": action('expect(page.locator("h1")).toBeTruthy();'),
  "no-unsafe-references": action('const a = "outer"; await page.evaluate(() => a);'),
  "no-unused-locators": action('page.locator("h1");'),
  "no-useless-await": action('await page.locator("h1");'),
  "no-useless-not": action('await expect(page.locator("h1")).not.toBeVisible();'),
  "no-wait-for-navigation": action("await page.waitForNavigation();"),
  "no-wait-for-selector": action('await page.waitForSelector("h1");'),
  "no-wait-for-timeout": action("await page.waitForTimeout(500);"),
  "prefer-hooks-in-order": suite(`test.afterEach(() => { console.log(1); });\n\n${hook}`),
  "prefer-hooks-on-top": suite(`${cleanPlaywright}\n\n${hook}`),
  "prefer-locator": action('await page.click("button");'),
  "prefer-to-have-count": action('expect(await page.locator("li").count()).toBe(2);'),
  "prefer-to-have-length": action("expect([1, 2].length).toBe(2);"),
  "prefer-web-first-assertions": action('expect(await page.locator("h1").isVisible()).toBe(true);'),
  "valid-describe-callback": 'test.describe("feature", async () => { console.log(1); });',
  "valid-expect": action("expect(1);"),
  "valid-expect-in-promise":
    'test("checks a promised result", () => { Promise.resolve(1).then((value) => expect(value).toBe(1)); });',
  "valid-test-tags": cleanPlaywright.replace('title",', 'title", { tag: "smoke" },'),
  "valid-title": cleanPlaywright.replace("shows the title", " "),
};

function playwrightLint(folder: string) {
  return new ESLint({
    cwd: folder,
    overrideConfigFile: join(import.meta.dirname, "../eslint.config.js"),
  });
}

async function playwrightMessages(folder: string, text: string) {
  const file = "example.spec.ts";
  writeFileSync(join(folder, file), text);
  const results = await playwrightLint(folder).lintFiles([file]);
  return results.flatMap(({ messages }) =>
    messages.flatMap(({ ruleId, severity }) =>
      ruleId?.startsWith("playwright/") ? [[ruleId, severity]] : [],
    ),
  );
}

test.each(Object.entries(violations))(
  "enforces playwright/%s at error severity",
  async (rule, source) => {
    using directory = testDirectory();
    expect(await playwrightMessages(directory.folder, playwrightImports + source)).toContainEqual([
      `playwright/${rule}`,
      2,
    ]);
    expect(await playwrightMessages(directory.folder, playwrightImports + cleanPlaywright)).toEqual(
      [],
    );
    writeFileSync(join(directory.folder, "fixture.ts"), playwrightFixture);
    expect(await playwrightMessages(directory.folder, fixtureImports + source)).toContainEqual([
      `playwright/${rule}`,
      2,
    ]);
  },
);

test("ignores Vitest even when it calls Playwright-shaped methods", async () => {
  using directory = testDirectory();
  const source =
    'import { test, expect } from "vitest";\n' +
    action("await page.waitForTimeout(500); expect(1).toBe(1);");
  expect(await playwrightMessages(directory.folder, source)).toEqual([]);
});

test("recognizes a spec importing an extended Playwright test from a local fixture", async () => {
  using directory = testDirectory();
  writeFileSync(join(directory.folder, "fixture.ts"), playwrightFixture);
  const source = 'import { test } from "./fixture";\n' + action("await page.waitForTimeout(500);");
  const messages = await playwrightMessages(directory.folder, source);
  expect(messages).toContainEqual(["playwright/no-wait-for-timeout", 2]);
});

const lintOxlint = join(import.meta.dirname, "../node_modules/oxlint/bin/oxlint");
const playwrightOverlapSource = `
test.describe("feature", () => {
  test.beforeEach(() => { console.log(1); });
  test.beforeEach(() => { console.log(2); });
  test.only("repeat", async ({ page }) => {
    await test.step("a step", async () => {
      await expect(page.locator("h1")).toBeVisible();
    });
  });
  test.skip("repeat", () => { console.log(3); });
  test(" ", () => { console.log(4); });
  test("conditional", ({ flag }) => { if (flag) expect(1).toBe(1); });
});
expect.poll(() => 1).toBe(1);
`;

test("the structure check and Oxlint leave Playwright constructs to ESLint", async () => {
  using directory = testDirectory();
  const shared = join(import.meta.dirname, "../config");
  const files = {
    ".oxlintrc.json": JSON.stringify({
      extends: [join(shared, "oxlint.json")],
      plugins: ["typescript"],
      env: { node: true },
    }),
    "eslint.config.js": `export { default } from ${JSON.stringify(join(shared, "eslint.js"))};`,
    "direct.prop.test.js": playwrightImports + playwrightOverlapSource,
    "extended.spec.js": 'import { test, expect } from "./fixture";\n' + playwrightOverlapSource,
    "fixture.js": playwrightFixture,
    "unit.spec.js":
      'import { test, expect } from "vitest"; test.only("unit", () => { expect(1).toBe(1); });',
  };
  for (const [file, source] of Object.entries(files))
    writeFileSync(join(directory.folder, file), source);
  expect(await lintOverlaps(directory.folder)).toEqual([]);
  const run = spawnSync(
    process.execPath,
    ["--bun", lintOxlint, "direct.prop.test.js", "extended.spec.js", "unit.spec.js"],
    {
      cwd: directory.folder,
      encoding: "utf8",
    },
  );
  const nativeFindings = run.stdout.split("\n").filter((line) => line.includes("vitest("));
  expect(nativeFindings).toEqual([
    expect.stringMatching(/^unit\.spec\.js:.*vitest\(no-focused-tests\)/),
  ]);
});

test.each([
  [
    'test("works in Chromium", ({ browserName }) => { test.skip(browserName !== "chromium", "Chromium only"); expect(true).toBe(true); });',
    [],
  ],
  [cleanPlaywright.replace("test(", "test.skip("), [["playwright/no-skipped-test", 2]]],
  [
    'test.describe.skip("feature", () => { console.log(1); });',
    [["playwright/no-skipped-test", 2]],
  ],
  [action("test.skip();"), [["playwright/no-skipped-test", 2]]],
])("enforces the Playwright skip policy for %s", async (source, expected) => {
  using directory = testDirectory();
  const messages = await playwrightMessages(directory.folder, playwrightImports + source);
  expect(messages.filter(([rule]) => rule === "playwright/no-skipped-test")).toEqual(expected);
});

const localPlaywrightNames = action(`
  await page.evaluate(() => {
    function describe(element) { return element.textContent; }
    const required = (element) => element;
    const expect = (value) => value;
    const inspect = (test) => test.only("label", () => "local");
    const link = document.querySelector("a");
    return [describe(link), describe(required(link)), expect("local"), inspect({ only: (label) => label })];
  });
  await expect(page.locator("h1")).toBeVisible();
`);

test("ignores locally declared Playwright-shaped calls within page.evaluate", async () => {
  using directory = testDirectory();
  expect(
    await playwrightMessages(directory.folder, playwrightImports + localPlaywrightNames),
  ).toEqual([]);
});

test("reports an invalid imported suite beside local Playwright-shaped calls", async () => {
  using directory = testDirectory();
  const source = `${playwrightImports}${localPlaywrightNames}\n\ntest.describe("x", "not a function");`;
  expect(await playwrightMessages(directory.folder, source)).toEqual([
    ["playwright/valid-describe-callback", 2],
  ]);
});

test("keeps reports on an unresolved Playwright-shaped global", async () => {
  using directory = testDirectory();
  const source = `${playwrightImports}${cleanPlaywright}\n\ndescribe("x", "not a function");`;
  expect(await playwrightMessages(directory.folder, source)).toEqual([
    ["playwright/valid-describe-callback", 2],
  ]);
});
