import { rejection } from "@hackersandwizards/scaffolding/rejection";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  checkMarkdown,
  checkStagedMarkdown,
  markdownLintRuns,
  markdownRuleGroups,
} from "../lib/markdown.ts";
import { installCleanGitEnvHooks } from "./git-env.ts";
import { testDirectory } from "./test-directory.ts";

installCleanGitEnvHooks();

test.each([
  [
    ["posts/z.md", "posts.md", "posts/a.md", "index.md"],
    [
      ["posts.md", "index.md"],
      ["posts/z.md", "posts/a.md"],
    ],
  ],
])("keeps strict and content files in input order", (paths, expected) => {
  expect(markdownRuleGroups(paths, ["posts"]).map(([group]) => group)).toEqual(expected);
});

test.each([["draft.md", "# Draft\n"]])(
  "fixes a working-tree file and returns success when no finding remains",
  async (path, expected) => {
    using temp = testDirectory();
    const file = join(temp.folder, path);
    writeFileSync(file, "# Draft \n");
    expect(await checkMarkdown(temp.folder, [path], true)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(expected);
  },
);

test.each([
  [
    { extra: [] },
    "scaffolding.markdown selects which folders use the Markdown content rules. In package.json, set it to an object with only the optional content key.",
  ],
])(
  "validates the index manifest before accepting an empty staged input",
  async (markdown, expected) => {
    using temp = testDirectory();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    execFileSync("git", ["init", "-q"], { cwd: temp.folder, env });
    const manifest = join(temp.folder, "package.json");
    writeFileSync(manifest, JSON.stringify({ scaffolding: { markdown } }));
    execFileSync("git", ["add", "package.json"], { cwd: temp.folder, env });
    writeFileSync(manifest, JSON.stringify({ scaffolding: { markdown: { content: "worktree" } } }));
    expect(await rejection(checkStagedMarkdown(temp.folder, {}))).toBe(`Error: ${expected}`);
  },
);

test.each([
  {
    paths: ["posts/z.md", "report[1].md", "posts/a.md"],
    argv: [[":report[1].md"], [":posts/z.md", ":posts/a.md"]],
    inlineHtml: [{ allowed_elements: ["br"] }, false],
  },
  { paths: [], argv: [], inlineHtml: [] },
])(
  "plans literal arguments and rules for each nonempty group ($paths)",
  ({ paths, argv, inlineHtml }) => {
    const runs = markdownLintRuns(markdownRuleGroups(paths, ["posts"]));
    expect(runs.map((run) => run.argv)).toEqual(argv);
    expect(runs.map((run) => run.rules.MD033)).toEqual(inlineHtml);
  },
);

test.each([
  [
    { "posts/content.md": "# Bad heading \n", "strict.md": "No title.\n" },
    ["strict.md:1", "posts/content.md:1"],
  ],
])("runs strict diagnostics before content diagnostics", async (contents, expected) => {
  using temp = testDirectory();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  mkdirSync(join(temp.folder, "posts"));
  execFileSync("git", ["init", "-q"], { cwd: temp.folder, env });
  writeFileSync(
    join(temp.folder, "package.json"),
    JSON.stringify({ scaffolding: { markdown: { content: ["posts"] } } }),
  );
  execFileSync("git", ["add", "package.json"], { cwd: temp.folder, env });
  const messages: string[] = [];
  using _logError = vi.spyOn(console, "error").mockImplementation((message: string) => {
    messages.push(message.split(/[ :]/u).slice(0, 2).join(":"));
  });
  const result = await checkStagedMarkdown(temp.folder, contents);
  expect(result).toBe(1);
  expect(messages).toEqual(expected);
});
