import { expect, test } from "vitest";
import { markdownRuleGroups } from "../lib/markdown.ts";

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
