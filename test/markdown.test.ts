import { rejection } from "@hackersandwizards/scaffolding/rejection";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  checkMarkdown,
  checkStagedMarkdown,
  lintMarkdownGroups,
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
  [{ extra: [] }, "scaffolding.markdown must be an object with only the optional content key"],
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
  [
    { "posts/content.md": "# Bad heading \n", "strict.md": "No title.\n" },
    ["strict.md:1", "posts/content.md:1"],
  ],
])("runs strict diagnostics before content diagnostics", async (contents, expected) => {
  using temp = testDirectory();
  const messages: string[] = [];
  using _logError = vi.spyOn(console, "error").mockImplementation((message: string) => {
    messages.push(message.split(/[ :]/u).slice(0, 2).join(":"));
  });
  const result = await lintMarkdownGroups(markdownRuleGroups(Object.keys(contents), ["posts"]), {
    directory: temp.folder,
    argv: [],
    fileContents: contents,
  });
  expect(result).toBe(1);
  expect(messages).toEqual(expected);
});
